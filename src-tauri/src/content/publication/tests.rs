use super::*;
use crate::content::{Fields, Kind, SaveMode};

fn workspace() -> Workspace {
    Workspace::open(std::path::Path::new(":memory:")).unwrap()
}

fn fields(title: &str, text: &str, url: &str, tags: &[&str]) -> Fields {
    serde_json::from_value(
        json!({"title":title,"contentMd":text,"status":"published","categoryId":null,
        "tags":tags,"summary":"","source":null,"publishedAt":null,"publishedUrl":url}),
    )
    .unwrap()
}

fn input() -> Input {
    Input {
        entry_id: "current".into(),
        title: "向量数据库检索实践".into(),
        summary: "".into(),
        tags: vec!["向量检索".into()],
        content_md: "理解向量数据库的索引与相似度检索".into(),
        category_id: None,
        status: "draft".into(),
        published_at: None,
        count: 5,
        authors: vec![],
    }
}

fn authored(db: &Workspace, author: &str, key: &str) -> crate::content::Entry {
    let mut data = fields("向量数据库检索实践", "向量检索", &format!("https://mp.weixin.qq.com/s/{key}"), &[]);
    data.source = Some(serde_json::from_value(json!({"url":format!("https://example.com/{key}"),
        "author":author,"accountName":"","originalPublishedAt":null,"importedAt":null})).unwrap());
    db.create_entry(Kind::Article, Some(data), None).unwrap()
}

#[test]
fn exact_author_filters_accept_any_selected_author_and_do_not_invalidate_manual_items() {
    let db = workspace();
    let first = authored(&db, "Alice", "alice-capital");
    authored(&db, "alice", "alice-lower");
    authored(&db, "Alice Lin", "alice-long");
    authored(&db, "", "anonymous");
    let mut request = input();
    assert_eq!(db.wechat_candidates(&request, "", false, 0).unwrap().items.len(), 4);
    request.authors = vec!["Alice".into()];
    let page = db.wechat_candidates(&request, "", false, 0).unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].article.entry_id, first.row.id);
    assert_eq!(db.wechat_recommend(&request).unwrap().items.len(), 1);
    request.authors.push("alice".into());
    assert_eq!(db.wechat_recommend(&request).unwrap().items.len(), 2);
    let fingerprint = request.fingerprint();
    request.authors = vec!["其他作者".into()];
    assert_ne!(request.fingerprint(), fingerprint);
    assert!(db.wechat_recommend(&request).unwrap().items.is_empty());
    assert!(db.wechat_resolve(&request, &[page.items[0].article.clone()]).unwrap().invalid.is_empty());
}

#[test]
fn materialized_author_options_follow_source_edits_trash_restore_sync_and_deletion() {
    let db = workspace();
    let first = authored(&db, "同名作者", "one");
    let second = authored(&db, "同名作者", "two");
    assert_eq!(db.wechat_authors().unwrap(), ["同名作者"]);
    db.write(|tx| { tx.execute("UPDATE entries SET deleted_at=1 WHERE id=?1", [&first.row.id])?; Ok(()) }).unwrap();
    assert_eq!(db.wechat_authors().unwrap(), ["同名作者"]);
    db.write(|tx| { tx.execute("UPDATE entries SET status='draft' WHERE id=?1", [&second.row.id])?; Ok(()) }).unwrap();
    assert!(db.wechat_authors().unwrap().is_empty());
    db.write(|tx| { tx.execute("UPDATE entries SET deleted_at=NULL WHERE id=?1", [&first.row.id])?; Ok(()) }).unwrap();
    assert_eq!(db.wechat_authors().unwrap(), ["同名作者"]);
    // A legacy source without entry-local overrides follows changes to its shared source.
    db.write(|tx| {
        tx.execute("UPDATE entries SET source_details=NULL WHERE id=?1", [&first.row.id])?;
        tx.execute("UPDATE sources SET author='新作者' WHERE id=(SELECT source_id FROM entries WHERE id=?1)", [&first.row.id])?;
        Ok(())
    }).unwrap();
    assert_eq!(db.wechat_authors().unwrap(), ["新作者"]);
    let snapshot = db.read(|conn| super::super::sync::snapshot(conn, &first.row.id)).unwrap().unwrap();
    let target = workspace();
    target.write(|tx| super::super::sync::apply(tx, &first.row.id, &snapshot, None)).unwrap();
    assert_eq!(target.wechat_authors().unwrap(), ["新作者"]);
    db.write(|tx| { tx.execute("DELETE FROM entries WHERE id=?1", [&first.row.id])?; Ok(()) }).unwrap();
    assert!(db.wechat_authors().unwrap().is_empty());
}

#[test]
fn author_index_migration_backfills_existing_articles_and_survives_reopening() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("content.db");
    let db = Workspace::open(&path).unwrap();
    authored(&db, "已有作者", "published-before-upgrade");
    let draft = authored(&db, "草稿作者", "draft-before-upgrade");
    db.write(|tx| {
        tx.execute("UPDATE entries SET status='draft' WHERE id=?1", [&draft.row.id])?;
        tx.execute_batch("DROP TRIGGER wechat_author_entry_insert;
            DROP TRIGGER wechat_author_entry_update;
            DROP TRIGGER wechat_author_source_update;
            DROP TABLE wechat_author_entries;
            DROP TABLE wechat_author_options;")?;
        tx.pragma_update(None, "user_version", crate::db::SCHEMA_VERSION - 1)?;
        Ok(())
    }).unwrap();
    drop(db);
    let upgraded = Workspace::open(&path).unwrap();
    assert_eq!(upgraded.wechat_authors().unwrap(), ["已有作者"]);
    assert_eq!(upgraded.wechat_candidates(&input(), "", false, 0).unwrap().items.len(), 1);
    drop(upgraded);
    assert_eq!(Workspace::open(&path).unwrap().wechat_authors().unwrap(), ["已有作者"]);
}

#[test]
fn author_defaults_roundtrip_and_legacy_defaults_remain_unfiltered() {
    let db = workspace();
    let config: DefaultsConfig = serde_json::from_value(json!({"schemaVersion":1,"recommendationCount":5})).unwrap();
    assert!(config.recommendation_authors.is_empty());
    let saved = db.save_wechat_defaults(0, DefaultsConfig { recommendation_authors: vec!["Alice".into(), "alice".into()], ..config }).unwrap();
    assert_eq!(saved.config.recommendation_authors, ["Alice", "alice"]);
    let snapshot = db.read(|conn| defaults_snapshot(conn, "default")).unwrap().unwrap();
    let target = workspace();
    target.write(|tx| apply_defaults(tx, "default", &snapshot)).unwrap();
    assert_eq!(target.wechat_defaults().unwrap().config.recommendation_authors, ["Alice", "alice"]);
    for authors in [json!([""]), json!([" Alice"]), json!(["Alice", "Alice"])] {
        let config: DefaultsConfig = serde_json::from_value(json!({"schemaVersion":1,"recommendationCount":5,"recommendationAuthors":authors})).unwrap();
        assert!(config.validate().is_err());
    }
}

#[test]
fn publication_preserves_manual_empty_and_missing_differs_from_explicit_null() {
    let db = workspace();
    let mut data = fields("当前文稿", "正文", "", &[]);
    let config = json!({"schemaVersion":1,"recommendations":{"enabled":false,"mode":"manual",
        "countOverride":null,"inputFingerprint":null,"items":[]}});
    data.wechat_publication = Some(Some(serde_json::from_value(config.clone()).unwrap()));
    let entry = db.create_entry(Kind::Article, Some(data), None).unwrap();
    let id = &entry.row.id;
    let mut omitted = fields("改名", "正文修改", "", &[]);
    omitted.status = "draft".into();
    db.save_entry(id, entry.version, omitted, SaveMode::Auto)
        .unwrap();
    let snapshot = db
        .read(|conn| super::super::sync::snapshot(conn, id))
        .unwrap()
        .unwrap();
    assert_eq!(snapshot["wechatPublication"], config);
    let target = workspace();
    target
        .write(|tx| super::super::sync::apply(tx, id, &snapshot, None))
        .unwrap();
    assert_eq!(
        serde_json::to_value(target.get_entry(id).unwrap()).unwrap()["wechatPublication"],
        config
    );
    let mut legacy = snapshot.clone();
    legacy.as_object_mut().unwrap().remove("wechatPublication");
    target
        .write(|tx| super::super::sync::apply(tx, id, &legacy, None))
        .unwrap();
    assert_eq!(
        serde_json::to_value(target.get_entry(id).unwrap()).unwrap()["wechatPublication"],
        config
    );
    let mut cleared = snapshot;
    cleared["wechatPublication"] = Value::Null;
    target
        .write(|tx| super::super::sync::apply(tx, id, &cleared, None))
        .unwrap();
    assert!(
        serde_json::to_value(target.get_entry(id).unwrap()).unwrap()["wechatPublication"].is_null()
    );
}

#[test]
fn defaults_are_versioned_captured_and_replayed_without_creating_startup_records() {
    let db = workspace();
    assert_eq!(db.wechat_defaults().unwrap().config.recommendation_count, 5);
    assert!(
        db.read(|conn| defaults_snapshot(conn, "default"))
            .unwrap()
            .is_none()
    );
    db.write(|tx| {
        tx.execute("UPDATE sync_progress SET capture=1", [])?;
        Ok(())
    })
    .unwrap();
    let saved = db
        .save_wechat_defaults(
            0,
            DefaultsConfig {
                schema_version: 1,
                recommendation_count: 8,
                recommendation_authors: vec![],
            },
        )
        .unwrap();
    assert_eq!(saved.version, 1);
    assert!(
        db.save_wechat_defaults(
            0,
            DefaultsConfig {
                schema_version: 1,
                recommendation_count: 3,
                recommendation_authors: vec![]
            }
        )
        .is_err()
    );
    assert!(db.read(|conn|Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM sync_dirty WHERE entity_type='wechat_publication_defaults')",[],|row|row.get::<_,bool>(0))?)).unwrap());
    let snapshot = db
        .read(|conn| defaults_snapshot(conn, "default"))
        .unwrap()
        .unwrap();
    let target = workspace();
    target
        .write(|tx| apply_defaults(tx, "default", &snapshot))
        .unwrap();
    assert_eq!(
        target
            .wechat_defaults()
            .unwrap()
            .config
            .recommendation_count,
        8
    );
    assert!(
        target
            .save_wechat_defaults(
                1,
                DefaultsConfig {
                    schema_version: 1,
                    recommendation_count: 0,
                    recommendation_authors: vec![]
                }
            )
            .is_err()
    );
}

#[test]
fn only_published_wechat_links_are_eligible_and_live_resolution_rejects_deleted_articles() {
    let db = workspace();
    let valid = db
        .create_entry(
            Kind::Article,
            Some(fields(
                "向量检索入门",
                "正文",
                "https://mp.weixin.qq.com/s/vector",
                &["向量检索"],
            )),
            None,
        )
        .unwrap();
    db.create_entry(
        Kind::Article,
        Some(fields(
            "知乎文章",
            "正文",
            "https://zhuanlan.zhihu.com/p/1",
            &[],
        )),
        None,
    )
    .unwrap();
    db.create_entry(
        Kind::Article,
        Some(fields(
            "伪造域名",
            "正文",
            "https://mp.weixin.qq.com.example/s/1",
            &[],
        )),
        None,
    )
    .unwrap();
    db.create_entry(
        Kind::Article,
        Some(fields("微信首页", "正文", "https://mp.weixin.qq.com/", &[])),
        None,
    )
    .unwrap();
    let mut modern = fields(
        "已指定微信但未填链接",
        "正文",
        "https://mp.weixin.qq.com/s/old",
        &[],
    );
    modern.publication_platforms = Some(vec![super::super::PublicationPlatform {
        platform: "微信公众号".into(),
        url: "".into(),
    }]);
    db.create_entry(Kind::Article, Some(modern), None).unwrap();
    let result = db.wechat_candidates(&input(), "", false, 0).unwrap();
    assert_eq!(result.items.len(), 1);
    assert_eq!(result.items[0].article.entry_id, valid.row.id);
    let items = result
        .items
        .into_iter()
        .map(|item| item.article)
        .collect::<Vec<_>>();
    db.write(|tx| {
        tx.execute(
            "UPDATE entries SET deleted_at=1 WHERE id=?1",
            [&valid.row.id],
        )?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        db.wechat_resolve(&input(), &items).unwrap().invalid.len(),
        1
    );
}

#[test]
fn ranking_prefers_specific_topics_without_padding_to_five_and_handles_chinese_short_words() {
    let db = workspace();
    let related = db
        .create_entry(
            Kind::Article,
            Some(fields(
                "向量数据库索引原理",
                "如何构建向量检索索引",
                "https://mp.weixin.qq.com/s/vector",
                &["向量检索"],
            )),
            None,
        )
        .unwrap();
    db.create_entry(
        Kind::Article,
        Some(fields(
            "周末烘焙与厨房收纳",
            "蛋糕和厨房用品整理",
            "https://mp.weixin.qq.com/s/kitchen",
            &["生活"],
        )),
        None,
    )
    .unwrap();
    let result = db.wechat_recommend(&input()).unwrap();
    assert_eq!(result.items.len(), 1);
    assert_eq!(result.items[0].entry_id, related.row.id);
    let mut short = input();
    short.title = "微信".into();
    short.content_md.clear();
    short.tags = vec!["配图".into()];
    db.create_entry(
        Kind::Article,
        Some(fields(
            "微信配图",
            "阅读画面",
            "https://mp.weixin.qq.com/s/images",
            &["配图"],
        )),
        None,
    )
    .unwrap();
    assert_eq!(
        db.wechat_candidates(&short, "配图", false, 0)
            .unwrap()
            .items
            .len(),
        1
    );
    assert!(
        db.wechat_recommend(&short)
            .unwrap()
            .items
            .iter()
            .any(|item| item.title == "微信配图")
    );
}

#[test]
fn wechat_url_identity_preserves_article_parameters_and_rejects_non_article_paths() {
    assert_eq!(
        article_url("http://mp.weixin.qq.com/s/abc?scene=1"),
        article_url("https://mp.weixin.qq.com/s/abc")
    );
    assert_eq!(
        article_url("https://mp.weixin.qq.com/s?__biz=abc&mid=123&idx=1&sn=signature&scene=1"),
        article_url("https://mp.weixin.qq.com/s?idx=1&mid=123&__biz=abc")
    );
    for url in [
        "https://mp.weixin.qq.com/",
        "https://mp.weixin.qq.com/debug/a",
        "https://user@mp.weixin.qq.com/s/abc",
        "https://mp.weixin.qq.com/s?__biz=abc",
        "javascript:alert(1)",
    ] {
        assert!(article_url(url).is_none(), "{url}");
    }
}

#[test]
fn generic_shared_tags_do_not_make_unrelated_articles_recommendations() {
    let db = workspace();
    db.create_entry(
        Kind::Article,
        Some(fields(
            "厨房烘焙",
            "做一份蛋糕",
            "https://mp.weixin.qq.com/s/kitchen",
            &["原创", "技术"],
        )),
        None,
    )
    .unwrap();
    let mut current = input();
    current.title = "RAG".into();
    current.content_md.clear();
    current.summary.clear();
    current.tags = vec!["原创".into(), "技术".into()];
    assert!(db.wechat_recommend(&current).unwrap().items.is_empty());
}

#[test]
fn ineligible_platforms_do_not_consume_wechat_recommendation_positions() {
    let db = workspace();
    let target = db
        .create_entry(
            Kind::Article,
            Some(fields(
                "实践记录",
                "RAG 向量检索",
                "https://mp.weixin.qq.com/s/rag",
                &[],
            )),
            None,
        )
        .unwrap();
    for index in 0..8 {
        db.create_entry(
            Kind::Article,
            Some(fields("RAG", "RAG", "https://example.com/article", &[])),
            None,
        )
        .unwrap();
        let _ = index;
    }
    let mut current = input();
    current.title = "RAG".into();
    current.content_md.clear();
    current.summary.clear();
    current.tags.clear();
    let result = db.wechat_recommend(&current).unwrap();
    assert_eq!(result.items.len(), 1);
    assert_eq!(result.items[0].entry_id, target.row.id);
}

#[test]
fn body_linked_articles_are_excluded_before_scoring_and_budgeting() {
    let db = workspace();
    let target = db
        .create_entry(
            Kind::Article,
            Some(fields(
                "实践记录",
                "RAG 索引",
                "https://mp.weixin.qq.com/s/target",
                &[],
            )),
            None,
        )
        .unwrap();
    let mut current = input();
    current.title = "RAG".into();
    current.tags.clear();
    current.summary.clear();
    current.content_md.clear();
    for index in 0..8 {
        let url = format!("https://mp.weixin.qq.com/s/linked-{index}");
        db.create_entry(Kind::Article, Some(fields("RAG", "RAG", &url, &[])), None)
            .unwrap();
        current.content_md.push_str(&format!("[a]({url})\n\n"));
    }
    let result = db.wechat_recommend(&current).unwrap();
    assert_eq!(result.items.len(), 1);
    assert_eq!(result.items[0].entry_id, target.row.id);
}

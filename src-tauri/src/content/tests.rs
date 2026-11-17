use super::*;

fn memory() -> Workspace {
    Workspace::open(std::path::Path::new(":memory:")).unwrap()
}

fn article(title: &str, text: &str) -> Fields {
    Fields {
        title: title.into(),
        content_md: text.into(),
        status: "draft".into(),
        category_id: None,
        cover_asset_id: None,
        theme_id: None,
        tags: vec![],
        summary: String::new(),
        source: None,
        published_at: None,
        published_url: String::new(),
    }
}

fn search(query: &str) -> Filter {
    Filter {
        query: Some(query.into()),
        ..Filter::default()
    }
}

#[test]
fn timeline_counts_and_filters_live_articles_by_folder_and_tag() {
    let db = memory();
    let parent = db.save_category(None, None, "写作", None).unwrap();
    let child = db
        .save_category(None, Some(&parent.id), "草稿", None)
        .unwrap();
    let mut tagged = article("微信文章", "正文");
    tagged.category_id = Some(parent.id.clone());
    tagged.tags = vec!["资料".into(), "wechat".into()];
    let tagged = db.create_entry(Kind::Article, Some(tagged), None).unwrap();
    let mut untagged = article("无标签文章", "正文");
    untagged.category_id = Some(child.id.clone());
    let untagged = db
        .create_entry(Kind::Article, Some(untagged), None)
        .unwrap();
    let mut root = article("根目录文章", "正文");
    root.tags.push("根目录标签".into());
    let root = db.create_entry(Kind::Article, Some(root), None).unwrap();
    db.set_entry_pinned(&root.row.id, true).unwrap();
    let mut deleted = article("回收站文章", "");
    deleted.tags.push("wechat".into());
    let deleted = db.create_entry(Kind::Article, Some(deleted), None).unwrap();
    db.set_deleted(&deleted.row.id, deleted.version, true)
        .unwrap();
    let mut idea = Fields::empty(Kind::Idea);
    idea.category_id = Some(parent.id.clone());
    idea.tags.push("wechat".into());
    db.create_entry(Kind::Idea, Some(idea), None).unwrap();

    let library = serde_json::to_value(db.library_with_article_counts(true).unwrap()).unwrap();
    let tag = library["tags"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tag| tag["name"] == "wechat")
        .unwrap();
    let tag_id = tag["id"].as_str().unwrap();
    let counts = &library["articleCounts"];
    assert_eq!(counts["root"], 1);
    assert_eq!(counts["folders"][&parent.id], 1);
    assert_eq!(counts["folders"][&child.id], 1);
    assert_eq!(counts["tags"][tag_id], 1);
    assert_eq!(counts["untagged"], 1);
    assert!(
        serde_json::to_value(db.library().unwrap())
            .unwrap()
            .get("articleCounts")
            .is_none()
    );

    let page = db
        .entries(Filter {
            kind: Some(Kind::Article),
            tag_ids: Some(vec![tag_id.into()]),
            include_preview: true,
            ..Filter::default()
        })
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].id, tagged.row.id);
    assert_eq!(
        page.items[0].preview.as_ref().unwrap().tags,
        ["wechat", "资料"]
    );
    let page = db
        .entries(Filter {
            kind: Some(Kind::Article),
            untagged: true,
            include_preview: true,
            ..Filter::default()
        })
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].id, untagged.row.id);
    assert!(page.items[0].preview.as_ref().unwrap().tags.is_empty());

    let page = db
        .entries(Filter {
            kind: Some(Kind::Article),
            exact_category: true,
            pinned: Some(true),
            include_preview: true,
            ..Filter::default()
        })
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].id, root.row.id);
}

#[test]
fn timeline_projects_previews_and_pages_a_folder_by_updated_time() {
    let db = memory();
    let parent = db.save_category(None, None, "文章目录", None).unwrap();
    let child = db
        .save_category(None, Some(&parent.id), "子目录", None)
        .unwrap();
    let mut first = article("直属文章", "正文");
    first.category_id = Some(parent.id.clone());
    first.summary = " 手写摘要\n第二行 ".into();
    let first = db.create_entry(Kind::Article, Some(first), None).unwrap();
    let mut second = article(
        "子目录文章",
        "![说明文字](asset://inline)\n\n这是 **正文** 第一段。\n\n下一段。",
    );
    second.category_id = Some(child.id);
    let second = db.create_entry(Kind::Article, Some(second), None).unwrap();
    db.create_entry(Kind::Article, Some(article("根目录文章", "")), None)
        .unwrap();
    db.write(|tx| {
        tx.execute(
            "UPDATE entries SET updated_at=100 WHERE id=?1",
            [&first.row.id],
        )?;
        tx.execute(
            "UPDATE entries SET updated_at=200 WHERE id=?1",
            [&second.row.id],
        )?;
        Ok(())
    })
    .unwrap();

    let list = |exact_category, offset, include_preview| {
        db.entries(Filter {
            category_id: Some(parent.id.clone()),
            kind: Some(Kind::Article),
            exact_category,
            sort: Some(EntrySort::Updated),
            include_preview,
            limit: NonZeroU32::new(1),
            offset,
            ..Filter::default()
        })
        .unwrap()
    };
    let latest = list(false, 0, true);
    assert_eq!(latest.next_offset, Some(1));
    assert_eq!(latest.items[0].id, second.row.id);
    let row = serde_json::to_value(&latest.items[0]).unwrap();
    assert_eq!(row["preview"]["summary"], "这是 正文 第一段。 下一段。");
    assert_eq!(row["preview"]["image"], "asset://inline");
    assert!(row.get("contentMd").is_none());

    for page in [list(false, 1, true), list(true, 0, true)] {
        assert_eq!(page.next_offset, None);
        assert_eq!(page.items[0].id, first.row.id);
        assert_eq!(
            page.items[0].preview.as_ref().unwrap().summary,
            "手写摘要 第二行"
        );
    }
    let plain = serde_json::to_value(&list(false, 0, false).items[0]).unwrap();
    assert!(plain.get("preview").is_none());
    let explicit = entry_preview(
        "摘要",
        Some("cover".into()),
        "![图](asset://inline)",
        vec![],
    );
    assert_eq!(explicit.image.as_deref(), Some("asset://cover"));
}

#[test]
fn workspace_search_matches_persisted_scopes_before_pagination() {
    let db = memory();
    let root = db.save_category(None, None, "Notes", None).unwrap();
    let child = db
        .save_category(None, Some(&root.id), "Field reports", None)
        .unwrap();
    let mut fields = article(
        "Release Notes",
        "# First\nAlpha goes here.\nBeta follows.\n\n```text\n# Literal code\n```\n\n# Second\nGamma.",
    );
    fields.category_id = Some(child.id);
    fields.tags = vec!["技术资料".into()];
    fields.summary = "Weekly report".into();
    let note = db.create_entry(Kind::Article, Some(fields), None).unwrap();
    let second = db
        .create_entry(
            Kind::Article,
            Some(article("Alpha copy CAFÉ", "Alpha Beta")),
            None,
        )
        .unwrap();
    let find = |text: &str, case_sensitive| {
        db.entries(Filter {
            workspace_search: Some(search::WorkspaceSearch {
                text: text.into(),
                case_sensitive,
            }),
            limit: NonZeroU32::new(1),
            ..Filter::default()
        })
        .unwrap()
        .items
        .into_iter()
        .map(|item| item.id)
        .collect::<Vec<_>>()
    };
    for query in [
        r#"path:"notes/field reports/release notes" file:"release notes""#,
        r#"tag:#技术 [状态:草稿] [摘要:"weekly report"]"#,
        r#"section:(Alpha Beta "Literal code")"#,
        r#"release "Beta follows""#,
    ] {
        assert_eq!(
            find(query, false),
            std::slice::from_ref(&note.row.id),
            "{query}"
        );
    }
    assert_eq!(
        find("line:(Alpha Beta) file:café", false),
        std::slice::from_ref(&second.row.id)
    );
    assert!(find("section:(Beta Gamma)", false).is_empty());
    assert!(find("file:release", true).is_empty());
    assert!(find("file:café", true).is_empty());
    assert!(find("[来源]", false).is_empty());
    assert!(find("file:' OR 1=1 --", false).is_empty());
}

#[test]
fn notes_with_imported_sources_remain_editable_and_publishable() {
    let db = memory();
    let mut fields = article("导入的笔记", "原正文");
    fields.source = Some(Source {
        url: "https://mp.weixin.qq.com/s/note".into(),
        author: "作者".into(),
        account_name: "公众号".into(),
        original_published_at: Some(1),
        imported_at: None,
    });
    let note = db.create_entry(Kind::Article, Some(fields), None).unwrap();
    let mut fields = note.fields;
    fields.content_md = "已编辑".into();
    fields.status = "published".into();
    fields.published_url = "https://mp.weixin.qq.com/s/published".into();
    db.save_entry(&note.row.id, note.version, fields, SaveMode::Auto)
        .unwrap();
    let saved = db.get_entry(&note.row.id).unwrap();
    assert_eq!(saved.fields.content_md, "已编辑");
    assert_eq!(saved.fields.source.unwrap().author, "作者");
    assert_eq!(
        saved.fields.published_url,
        "https://mp.weixin.qq.com/s/published"
    );
    assert_eq!(saved.row.status, "published");
}

#[test]
fn folder_entry_order_survives_saves_and_restart_without_leaking_between_folders() {
    use taxonomy::CategoryPlacement::{After, Before};

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("content.db");
    let db = Workspace::open(&path).unwrap();
    let folder = db.save_category(None, None, "目录", None).unwrap();
    let create = |title: &str, rank: i64, category_id: Option<String>| {
        let mut fields = article(title, "");
        fields.category_id = category_id;
        let entry = db.create_entry(Kind::Article, Some(fields), None).unwrap();
        db.write(|tx| {
            tx.execute(
                "UPDATE entries SET updated_at=?2,created_at=100-?2 WHERE id=?1",
                params![entry.row.id, rank],
            )?;
            Ok(())
        })
        .unwrap();
        entry
    };
    let first = create("一", 10, None);
    let second = create("二", 20, None);
    let third = create("三", 30, None);
    let child = create("目录内", 40, Some(folder.id.clone()));
    let list = |db: &Workspace, category_id: Option<String>| {
        db.entries(Filter {
            exact_category: true,
            category_id,
            ..Filter::default()
        })
        .unwrap()
        .items
        .into_iter()
        .map(|entry| entry.id)
        .collect::<Vec<_>>()
    };
    assert_eq!(
        list(&db, None),
        [
            third.row.id.clone(),
            second.row.id.clone(),
            first.row.id.clone()
        ]
    );
    let sorted = db
        .entries(Filter {
            sort: Some(EntrySort::Name),
            exact_category: true,
            limit: std::num::NonZeroU32::new(2),
            ..Filter::default()
        })
        .unwrap();
    assert_eq!(sorted.next_offset, Some(2));
    assert_eq!(sorted.items[0].id, first.row.id);
    assert_eq!(sorted.items[1].id, third.row.id);
    let row = serde_json::to_value(&sorted.items[0]).unwrap();
    assert_eq!(row["createdAt"], 90);
    assert_eq!(row["updatedAt"], 10);
    for (sort, expected) in [
        (EntrySort::NameDesc, [&second, &third, &first]),
        (EntrySort::Updated, [&third, &second, &first]),
        (EntrySort::UpdatedAsc, [&first, &second, &third]),
        (EntrySort::Created, [&first, &second, &third]),
        (EntrySort::CreatedAsc, [&third, &second, &first]),
    ] {
        let page = db
            .entries(Filter {
                sort: Some(sort),
                exact_category: true,
                ..Filter::default()
            })
            .unwrap();
        assert_eq!(
            page.items
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            expected.map(|entry| entry.row.id.as_str())
        );
    }
    db.reorder_entry(&first.row.id, &third.row.id, Before)
        .unwrap();
    db.reorder_entry(&second.row.id, &first.row.id, After)
        .unwrap();
    assert!(
        db.reorder_entry(&first.row.id, &child.row.id, Before)
            .is_err()
    );
    let mut fields = first.fields;
    fields.title = "保存标题".into();
    let saved = db
        .save_entry(&first.row.id, first.version, fields, SaveMode::Auto)
        .unwrap();

    drop(db);
    let db = Workspace::open(&path).unwrap();
    assert_eq!(
        list(&db, None),
        [
            first.row.id.clone(),
            second.row.id.clone(),
            third.row.id.clone()
        ]
    );
    let mut fields = db.get_entry(&first.row.id).unwrap().fields;
    fields.category_id = Some(folder.id.clone());
    db.save_entry(&first.row.id, saved.version, fields, SaveMode::Auto)
        .unwrap();
    db.read(|conn| {
        let rank: Option<i64> = conn.query_row(
            "SELECT folder_sort_order FROM entries WHERE id=?1",
            [&first.row.id],
            |row| row.get(0),
        )?;
        assert_eq!(rank, None);
        Ok(())
    })
    .unwrap();
    assert_eq!(list(&db, None), [second.row.id, third.row.id]);
}

#[test]
fn pinned_entries_keep_an_independent_order_across_folders_and_restarts() {
    use taxonomy::CategoryPlacement::Before;

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pinned.db");
    let db = Workspace::open(&path).unwrap();
    let folder = db.save_category(None, None, "目录", None).unwrap();
    let first = db
        .create_entry(Kind::Article, Some(article("甲", "")), None)
        .unwrap();
    let regular = db
        .create_entry(Kind::Article, Some(article("丙", "")), None)
        .unwrap();
    let mut fields = article("乙", "");
    fields.category_id = Some(folder.id.clone());
    let second = db.create_entry(Kind::Article, Some(fields), None).unwrap();
    let pin_list = |db: &Workspace, sort| {
        db.entries(Filter {
            pinned: Some(true),
            sort,
            ..Filter::default()
        })
        .unwrap()
        .items
        .into_iter()
        .map(|entry| entry.id)
        .collect::<Vec<_>>()
    };

    db.set_entry_pinned(&first.row.id, true).unwrap();
    db.set_entry_pinned(&second.row.id, true).unwrap();
    assert_eq!(
        pin_list(&db, None),
        [second.row.id.as_str(), first.row.id.as_str()]
    );
    assert!(
        db.reorder_entry(&first.row.id, &regular.row.id, Before)
            .is_err()
    );
    assert!(
        db.reorder_entry(&regular.row.id, &first.row.id, Before)
            .is_err()
    );
    db.reorder_entry(&first.row.id, &second.row.id, Before)
        .unwrap();
    db.set_entry_pinned(&second.row.id, true).unwrap();
    drop(db);

    let db = Workspace::open(&path).unwrap();
    for sort in [None, Some(EntrySort::NameDesc), Some(EntrySort::UpdatedAsc)] {
        assert_eq!(
            pin_list(&db, sort),
            [first.row.id.as_str(), second.row.id.as_str()]
        );
    }
    let root = db
        .entries(Filter {
            pinned: Some(false),
            exact_category: true,
            ..Filter::default()
        })
        .unwrap();
    assert_eq!(root.items[0].id, regular.row.id);
    assert_eq!(root.items.len(), 1);
    let pinned = db.get_entry(&second.row.id).unwrap();
    assert!(pinned.row.pinned);
    assert_eq!(pinned.version, second.version);
    assert_eq!(
        pinned.fields.category_id.as_deref(),
        Some(folder.id.as_str())
    );
    db.set_entry_pinned(&second.row.id, false).unwrap();
    let children = db
        .entries(Filter {
            pinned: Some(false),
            exact_category: true,
            category_id: Some(folder.id),
            ..Filter::default()
        })
        .unwrap();
    assert_eq!(children.items[0].id, second.row.id);
    assert!(!children.items[0].pinned);
}

#[test]
fn external_updates_use_versions_and_distinguish_null_patch_values_from_omitted_values() {
    let db = Workspace::open(std::path::Path::new(":memory:")).unwrap();
    let create = serde_json::from_value(serde_json::json!({ "title":"原题", "contentMd":"原稿", "tags":["保留"], "publishedAt":42 })).unwrap();
    let article = db.create_external(Kind::Article, create).unwrap();
    let patch = || {
        serde_json::from_value(serde_json::json!({ "title":"新标题", "publishedAt":null })).unwrap()
    };
    assert_eq!(
        db.update_external(&article.row.id, article.version, patch())
            .unwrap()
            .version,
        article.version + 1
    );
    let current = db.get_entry(&article.row.id).unwrap();
    assert_eq!(current.fields.title, "新标题");
    assert_eq!(current.fields.content_md, "原稿");
    assert_eq!(current.fields.tags, vec!["保留"]);
    assert!(current.fields.published_at.is_none());
    assert_eq!(
        db.update_external(&article.row.id, article.version, patch())
            .err()
            .unwrap()
            .code(),
        "VERSION_CONFLICT"
    );
    db.begin_exit();
    assert_eq!(
        db.update_external(&article.row.id, current.version, patch())
            .err()
            .unwrap()
            .code(),
        "EXIT_PENDING"
    );
}

#[test]
fn migration_creates_wal_database_and_keeps_workspace_identity_on_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("content.db");
    let db = Workspace::open(&path).unwrap();
    let identity = db.read(crate::db::workspace_id).unwrap();
    db.read(|conn| {
        let mode: String = conn.pragma_query_value(None, "journal_mode", |r| r.get(0))?;
        let foreign_keys: bool = conn.pragma_query_value(None, "foreign_keys", |r| r.get(0))?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        assert_eq!(mode, "wal");
        assert!(foreign_keys);
        assert_eq!(version, crate::db::SCHEMA_VERSION);
        Ok(())
    })
    .unwrap();
    let entry = db
        .create_entry(Kind::Article, Some(article("标题", "中文草稿")), None)
        .unwrap();
    drop(db);
    let reopened = Workspace::open(&path).unwrap();
    assert_eq!(reopened.read(crate::db::workspace_id).unwrap(), identity);
    assert_eq!(
        reopened.get_entry(&entry.row.id).unwrap().fields.content_md,
        "中文草稿"
    );
    assert_eq!(reopened.entries(search("中文草")).unwrap().items.len(), 1);
}

#[test]
fn stale_versions_cannot_overwrite_and_only_key_saves_create_history() {
    let db = memory();
    let entry = db.create_entry(Kind::Article, None, None).unwrap();
    let id = &entry.row.id;
    let version = db
        .save_entry(id, 1, article("稿", "自动保存"), SaveMode::Auto)
        .unwrap()
        .version;
    assert_eq!(version, 2);
    assert!(db.revisions(id).unwrap().is_empty());
    let conflict = db
        .save_entry(id, 1, article("旧稿", "旧正文"), SaveMode::Auto)
        .err()
        .unwrap();
    let error = serde_json::to_value(conflict).unwrap();
    assert_eq!(error["code"], "VERSION_CONFLICT");
    assert_eq!(error["currentVersion"], 2);
    assert_eq!(db.get_entry(id).unwrap().fields.content_md, "自动保存");
    db.begin_exit();
    db.save_entry(id, 2, article("稿", "AI 改写"), SaveMode::AiReplace)
        .unwrap();
    db.cancel_exit();
    assert_eq!(db.get_entry(id).unwrap().fields.content_md, "AI 改写");
    let history = db.revisions(id).unwrap();
    assert_eq!(history[0].reason, "before_ai_replace");
    assert_eq!(history[0].content_md, "自动保存");
    for version in 3..7 {
        db.save_entry(
            id,
            version,
            article("稿", &version.to_string()),
            SaveMode::Manual,
        )
        .unwrap();
    }
    let history = db.revisions(id).unwrap();
    assert_eq!(
        history.iter().map(|r| r.version).collect::<Vec<_>>(),
        [7, 6, 5]
    );
    assert_eq!(history[0].content_md, "6");
    let dto = serde_json::to_value(db.get_entry(id).unwrap()).unwrap();
    let round_trip: Fields = serde_json::from_value(dto).unwrap();
    assert_eq!(
        (round_trip.title.as_str(), round_trip.content_md.as_str()),
        ("稿", "6")
    );
}

#[test]
fn literal_search_combines_category_and_normalized_tag_and_tracks_visibility() {
    let db = memory();
    let root = db.save_category(None, None, "选题", None).unwrap().id;
    let child = db
        .save_category(None, Some(&root), "访谈", None)
        .unwrap()
        .id;
    let mut fields = article("开头", "访问 A\"B，字面 %_ 和来宾");
    fields.category_id = Some(child.clone());
    fields.tags = vec!["  AI  Writing ".into(), "ai writing".into()];
    let entry = db.create_entry(Kind::Article, Some(fields), None).unwrap();
    db.create_entry(
        Kind::Article,
        Some(article("对照", "访问 A\"B，字面 XY 和来宾")),
        None,
    )
    .unwrap();
    let tag: String = db
        .read(|conn| Ok(conn.query_row("SELECT id FROM tags", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(entry.fields.tags, ["AI Writing"]);
    assert_eq!(db.entries(search("%_")).unwrap().items.len(), 1);
    assert_eq!(db.entries(search("宾")).unwrap().items.len(), 2);
    assert_eq!(db.entries(search("A\"B")).unwrap().items.len(), 2);
    let mut filtered = search("和来宾");
    filtered.category_id = Some(root.clone());
    filtered.tag_ids = Some(vec![tag]);
    assert_eq!(db.entries(filtered).unwrap().items[0].id, entry.row.id);

    assert!(
        db.save_category(None, Some(&child), "第三级", None)
            .is_err()
    );
    assert!(db.save_category(None, Some(&root), "访谈", None).is_err());
    db.delete_category(&child).unwrap();
    let moved = db.get_entry(&entry.row.id).unwrap();
    assert_eq!(moved.fields.category_id, Some(root));
    assert_eq!(moved.version, 2);
    let deleted = db.set_deleted(&entry.row.id, moved.version, true).unwrap();
    assert!(db.entries(search("%_")).unwrap().items.is_empty());
    let mut trash = search("%_");
    trash.deleted = true;
    assert_eq!(db.entries(trash).unwrap().items[0].id, entry.row.id);
    db.set_deleted(&entry.row.id, deleted.version, false)
        .unwrap();
    assert_eq!(db.entries(search("%_")).unwrap().items.len(), 1);
}

#[test]
fn wechat_import_filter_backfills_only_active_imports_after_source_edits() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("content.db");
    let connection = rusqlite::Connection::open(&path).unwrap();
    for migration in [
        include_str!("../../migrations/0001_initial.sql"),
        include_str!("../../migrations/0002_assets.sql"),
        include_str!("../../migrations/0003_wechat.sql"),
        include_str!("../../migrations/0004_ai.sql"),
        include_str!("../../migrations/0005_category_icons.sql"),
        include_str!("../../migrations/0006_folder_icon_set.sql"),
    ] {
        connection.execute_batch(migration).unwrap();
    }
    connection
        .execute_batch(
            "PRAGMA user_version=6;
             INSERT INTO app_settings VALUES ('workspace_id','old-workspace');
             INSERT INTO sources VALUES
              ('original','https://mp.weixin.qq.com/s/original','','',NULL,10),
              ('edited','https://example.com/edited','','',NULL,30),
              ('manual-original','https://mp.weixin.qq.com/s/manual-original','','',NULL,20),
              ('manual-alias','https://mp.weixin.qq.com/s/manual-alias','','',NULL,40),
              ('trash-source','https://mp.weixin.qq.com/s/trash','','',NULL,50);
             INSERT INTO entries(id,kind,title,content_md,status,source_id,created_at,updated_at,deleted_at)
             VALUES ('imported','reference','导入','','unread','edited',10,30,NULL),
                    ('manual','reference','手填','','unread','manual-alias',20,40,NULL),
                    ('trashed','reference','已删除','','unread','trash-source',50,99,99);
             INSERT INTO wechat_sources VALUES
              ('https://mp.weixin.qq.com/s/original','imported'),
              ('https://mp.weixin.qq.com/s/alias','imported'),
              ('https://mp.weixin.qq.com/s/trash','trashed'),
              ('https://mp.weixin.qq.com/s/manual-alias','manual');",
        )
        .unwrap();
    drop(connection);

    let db = Workspace::open(&path).unwrap();
    db.create_entry(Kind::Reference, None, None).unwrap();
    let filter = serde_json::from_value(
        serde_json::json!({"wechatImported":true,"deleted":false,"offset":0}),
    )
    .unwrap();
    let page = db.entries(filter).unwrap();
    assert_eq!(
        page.items
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>(),
        ["imported"]
    );
    assert_eq!(db.entries(Filter::default()).unwrap().items.len(), 3);
}

#[test]
fn folder_icons_are_returned_and_omission_preserves_the_icon_on_rename() {
    use taxonomy::CategoryIcon;

    let db = memory();
    let parent = db.save_category(None, None, "收集", None).unwrap();
    assert_eq!(parent.icon, CategoryIcon::Folder);
    let child = db
        .save_category(
            None,
            Some(&parent.id),
            "剪辑",
            Some(CategoryIcon::Newspaper),
        )
        .unwrap();
    assert_eq!(serde_json::to_value(&child).unwrap()["icon"], "newspaper");
    let renamed = db
        .save_category(Some(&child.id), None, "编辑", None)
        .unwrap();
    assert_eq!(renamed.id, child.id);
    assert_eq!(renamed.parent_id.as_deref(), Some(parent.id.as_str()));
    assert_eq!(renamed.icon, CategoryIcon::Newspaper);
    let icon = serde_json::from_value(serde_json::json!("bookmark")).unwrap();
    db.save_category(Some(&child.id), None, "编辑", Some(icon))
        .unwrap();
    let persisted = db
        .library()
        .unwrap()
        .categories
        .into_iter()
        .find(|item| item.id == child.id)
        .unwrap();
    assert_eq!(persisted.icon, CategoryIcon::Bookmark);
}

#[test]
fn folder_drop_reorders_only_siblings_and_existing_icons_survive_upgrade() {
    use taxonomy::{CategoryIcon, CategoryPlacement};

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("content.db");
    let connection = rusqlite::Connection::open(&path).unwrap();
    for migration in [
        include_str!("../../migrations/0001_initial.sql"),
        include_str!("../../migrations/0002_assets.sql"),
        include_str!("../../migrations/0003_wechat.sql"),
        include_str!("../../migrations/0004_ai.sql"),
        include_str!("../../migrations/0005_category_icons.sql"),
    ] {
        connection.execute_batch(migration).unwrap();
    }
    connection
        .execute_batch(
            "PRAGMA user_version=5;
         INSERT INTO app_settings VALUES ('workspace_id','old-workspace');
         INSERT INTO categories(id,parent_id,name,depth,sort_order,icon) VALUES
         ('first',NULL,'灵感',1,0,'star'),('middle',NULL,'中间',1,2,'book'),
         ('last',NULL,'末尾',1,9,'archive'),('nested','first','子目录',2,0,'newspaper');
         INSERT INTO entries(id,kind,title,content_md,status,category_id,created_at,updated_at)
         VALUES ('note','article','旧文','','draft','nested',1,1);",
        )
        .unwrap();
    drop(connection);

    let db = Workspace::open(&path).unwrap();
    db.reorder_category("last", "first", CategoryPlacement::Before)
        .unwrap();
    db.reorder_category("first", "middle", CategoryPlacement::After)
        .unwrap();
    assert!(
        db.reorder_category("first", "nested", CategoryPlacement::After)
            .is_err()
    );
    let icons = db.library().unwrap().categories;
    assert_eq!(
        icons
            .iter()
            .filter(|folder| folder.parent_id.is_none())
            .map(|folder| (folder.id.as_str(), folder.icon))
            .collect::<Vec<_>>(),
        [
            ("last", CategoryIcon::Archive),
            ("middle", CategoryIcon::Book),
            ("first", CategoryIcon::Star),
            ("builtin-articles", CategoryIcon::File),
            ("builtin-references", CategoryIcon::Book),
        ]
    );
    assert_eq!(
        serde_json::to_value(icons.iter().find(|folder| folder.id == "first").unwrap()).unwrap()["name"],
        "灵感"
    );
    drop(db);
    let db = Workspace::open(&path).unwrap();
    assert_eq!(db.library().unwrap().categories.len(), icons.len());
    assert_eq!(
        db.get_entry("note").unwrap().fields.category_id.as_deref(),
        Some("nested")
    );
    let edited = db
        .save_category(Some("nested"), None, "项目", Some(CategoryIcon::Rocket))
        .unwrap();
    assert_eq!(edited.parent_id.as_deref(), Some("first"));
    assert_eq!(edited.icon, CategoryIcon::Rocket);
}

#[test]
fn new_workspaces_start_with_three_editable_root_folders() {
    use taxonomy::CategoryIcon;

    let db = memory();
    let library = db.library().unwrap();
    let roots = serde_json::to_value(&library.categories).unwrap();
    assert_eq!(roots.as_array().unwrap().len(), 3);
    for (index, (name, icon)) in [
        ("文章", CategoryIcon::File),
        ("灵感", CategoryIcon::Lightbulb),
        ("资料", CategoryIcon::Book),
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(roots[index]["name"], name);
        assert_eq!(library.categories[index].icon, icon);
        assert!(library.categories[index].parent_id.is_none());
    }
    db.save_category(Some(&library.categories[0].id), None, "文章草稿", None)
        .unwrap();
}

#[test]
fn property_tag_suggestions_include_previous_tags_after_unlinking() {
    let db = memory();
    let mut fields = article("笔记", "正文");
    fields.tags = vec!["历史标签".into()];
    let entry = db.create_entry(Kind::Article, Some(fields), None).unwrap();
    let mut fields = entry.fields;
    fields.tags.clear();
    db.save_entry(&entry.row.id, entry.version, fields, SaveMode::Auto)
        .unwrap();
    let library = serde_json::to_value(db.library().unwrap()).unwrap();
    assert_eq!(library["tagSuggestions"], serde_json::json!(["历史标签"]));
    assert_eq!(library["tags"], serde_json::json!([]));
}

#[test]
fn exact_folder_filter_distinguishes_members_children_and_unassigned_entries() {
    let db = memory();
    let root = db.save_category(None, None, "选题", None).unwrap().id;
    let child = db
        .save_category(None, Some(&root), "子选题", None)
        .unwrap()
        .id;
    let create = |folder: Option<&str>| {
        let mut fields = article("标题", "测试正文");
        fields.category_id = folder.map(str::to_owned);
        db.create_entry(Kind::Article, Some(fields), None).unwrap()
    };
    let root_article = create(Some(&root));
    let child_article = create(Some(&child));
    let unassigned = create(None);
    let deleted = create(Some(&root));
    db.set_deleted(&deleted.row.id, deleted.version, true)
        .unwrap();

    let ids = |value| {
        let filter = serde_json::from_value(value).unwrap();
        let mut ids = db
            .entries(filter)
            .unwrap()
            .items
            .into_iter()
            .map(|item| item.id)
            .collect::<Vec<_>>();
        ids.sort_unstable();
        ids
    };
    let mut descendants = vec![root_article.row.id.clone(), child_article.row.id.clone()];
    descendants.sort_unstable();
    assert_eq!(
        ids(serde_json::json!({"categoryId":root,"deleted":false,"offset":0})),
        descendants
    );
    assert_eq!(
        ids(
            serde_json::json!({"categoryId":root,"exactCategory":true,"kind":"article","status":"draft","query":"测试正文","deleted":false,"offset":0})
        ),
        [root_article.row.id]
    );
    assert_eq!(
        ids(
            serde_json::json!({"categoryId":child,"exactCategory":true,"deleted":false,"offset":0})
        ),
        [child_article.row.id]
    );
    for filter in [
        serde_json::json!({"exactCategory":true,"deleted":false,"offset":0}),
        serde_json::json!({"categoryId":null,"exactCategory":true,"deleted":false,"offset":0}),
    ] {
        assert_eq!(
            ids(filter).as_slice(),
            std::slice::from_ref(&unassigned.row.id)
        );
    }
    assert_eq!(
        ids(serde_json::json!({"categoryId":root,"exactCategory":true,"deleted":true,"offset":0})),
        [deleted.row.id]
    );
}

#[test]
fn folder_listing_can_refresh_all_loaded_entries_in_one_page() {
    let db = memory();
    for title in ["灵感", "资料", "草稿"] {
        db.create_entry(Kind::Article, Some(article(title, "")), None)
            .unwrap();
    }
    let list = |limit| {
        db.entries(
            serde_json::from_value(serde_json::json!({
                "exactCategory": true, "deleted": false, "offset": 0, "limit": limit,
            }))
            .unwrap(),
        )
        .unwrap()
    };
    let first = list(1);
    assert_eq!(first.items.len(), 1);
    assert_eq!(first.next_offset, Some(1));
    let expanded = list(2);
    assert_eq!(expanded.items.len(), 2);
    assert_eq!(expanded.items[0].id, first.items[0].id);
    assert_eq!(expanded.next_offset, Some(2));
    assert_eq!(list(3).next_offset, None);
}

#[test]
fn article_keeps_source_relationship_and_exit_allows_pending_editor_saves() {
    let db = memory();
    let idea = db.create_entry(Kind::Idea, None, None).unwrap();
    let draft = db
        .create_entry(Kind::Article, None, Some(idea.row.id.clone()))
        .unwrap();
    assert_eq!(draft.links[0].id, idea.row.id);
    assert_eq!(
        db.get_entry(&idea.row.id).unwrap().links[0].id,
        draft.row.id
    );
    db.begin_exit();
    assert!(db.create_entry(Kind::Article, None, None).is_err());
    assert!(
        db.save_entry(
            &draft.row.id,
            1,
            article("退出前", "待提交"),
            SaveMode::Auto
        )
        .is_ok()
    );
    db.cancel_exit();
    assert!(db.create_entry(Kind::Idea, None, None).is_ok());
}

#[test]
fn another_reference_cannot_overwrite_existing_source_metadata() {
    let db = memory();
    let reference = |url: &str, author: &str| Fields {
        status: "unread".into(),
        source: Some(Source {
            url: url.into(),
            author: author.into(),
            account_name: String::new(),
            original_published_at: None,
            imported_at: None,
        }),
        ..article("资料", "正文")
    };
    let first = db
        .create_entry(
            Kind::Reference,
            Some(reference("https://example.test/#first", "作者甲")),
            None,
        )
        .unwrap();
    let second = db.create_entry(Kind::Reference, None, None).unwrap();
    let error = db
        .save_entry(
            &second.row.id,
            1,
            reference("https://example.test/", ""),
            SaveMode::Auto,
        )
        .err()
        .unwrap();
    assert!(error.to_string().contains("已收录"));
    let original = db.get_entry(&first.row.id).unwrap();
    assert_eq!(original.version, 1);
    assert_eq!(original.fields.source.unwrap().author, "作者甲");
    db.save_entry(
        &first.row.id,
        1,
        reference("https://example.test/", "作者乙"),
        SaveMode::Auto,
    )
    .unwrap();
    assert_eq!(
        db.get_entry(&first.row.id)
            .unwrap()
            .fields
            .source
            .unwrap()
            .author,
        "作者乙"
    );
}

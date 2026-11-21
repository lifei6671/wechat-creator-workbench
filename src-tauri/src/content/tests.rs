use super::*;

fn memory() -> Workspace {
    Workspace::open(std::path::Path::new(":memory:")).unwrap()
}

#[test]
fn category_icon_color_survives_reopen_rename_and_explicit_reset() {
    use super::taxonomy::{CategoryAppearance, CategoryIcon};
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("content.db");
    let db = Workspace::open(&path).unwrap();
    let appearance = CategoryAppearance { icon_color: Some("blue".into()) };
    let folder = db.save_category(None, None, "彩色目录", Some(CategoryIcon::Rocket), Some(&appearance)).unwrap();
    assert_eq!(folder.icon_color.as_deref(), Some("blue"));
    let renamed = db.save_category(Some(&folder.id), None, "改名", None, None).unwrap();
    assert_eq!(renamed.icon_color.as_deref(), Some("blue"));
    assert_eq!(renamed.icon, CategoryIcon::Rocket);
    let custom = CategoryAppearance { icon_color: Some("#123aBC".into()) };
    db.save_category(Some(&folder.id), None, "改名", Some(CategoryIcon::Book), Some(&custom)).unwrap();
    drop(db);
    let db = Workspace::open(&path).unwrap();
    let library = db.library().unwrap();
    let saved = library.categories.iter().find(|item| item.id == folder.id).unwrap();
    assert_eq!(saved.icon_color.as_deref(), Some("#123aBC"));
    assert_eq!(saved.icon, CategoryIcon::Book);
    let reset = CategoryAppearance { icon_color: None };
    assert!(db.save_category(Some(&folder.id), None, "改名", None, Some(&reset)).unwrap().icon_color.is_none());
    for color in ["red", "orange", "amber", "green", "blue", "violet", "#000000", "#fFfFfF"] {
        assert!(validate_color(Some(color)).is_ok());
    }
    for color in ["", "pink", "#fff", "#12345678", "#gg0000", "var(--blue-9)"] {
        let invalid = CategoryAppearance { icon_color: Some(color.into()) };
        assert!(db.save_category(Some(&folder.id), None, "不应改名", None, Some(&invalid)).is_err());
    }
    let library = db.library().unwrap();
    let saved = library.categories.iter().find(|item| item.id == folder.id).unwrap();
    assert_eq!(serde_json::to_value(saved).unwrap()["name"], "改名");
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
        custom_properties: None,
    }
}

fn search(query: &str) -> Filter {
    Filter {
        query: Some(query.into()),
        ..Filter::default()
    }
}

#[test]
fn external_imports_are_listed_once_and_keep_typed_properties_in_sync() {
    let db = memory();
    let source = |url: &str| Source {
        url: url.into(),
        author: "作者".into(),
        account_name: "示例".into(),
        imported_at: Some(1_795_132_800_000),
        original_published_at: Some(1_794_960_000_000),
    };
    let folder = db.save_category(None, None, "外部资料", None, None).unwrap();
    let mut local = article("手写文章", "");
    local.source = Some(source("https://example.com/local"));
    db.create_entry(Kind::Article, Some(local), None).unwrap();
    let import = || {
        db.import_web_article(
            source("https://example.com/article"),
            "导入文章".into(),
            "# Markdown".into(),
            "简介".into(),
            Some(folder.id.clone()),
            vec!["clippings".into()],
        )
        .unwrap()
    };
    let (id, existing, deleted) = import();
    assert!(!existing && !deleted);
    assert_eq!(import(), (id.clone(), true, false));
    let filter = || Filter { external_imported: true, ..Filter::default() };
    let listed = db.entries(filter()).unwrap().items;
    assert_eq!(listed.iter().map(|entry| &entry.id).collect::<Vec<_>>(), [&id]);

    let entry = db.get_entry(&id).unwrap();
    assert_eq!(entry.fields.tags, ["clippings"]);
    assert_eq!(db.library().unwrap().tags[0].name, "clippings");
    assert_eq!(entry.fields.title, "导入文章");
    assert_eq!(entry.fields.content_md, "# Markdown");
    assert_eq!(entry.fields.summary, "简介");
    assert_eq!(entry.fields.status, "draft");
    assert_eq!(entry.fields.published_at, None);
    let source = entry.fields.source.as_ref().unwrap();
    assert_eq!(source.author, "作者");
    assert_eq!(source.original_published_at, Some(1_794_960_000_000));
    assert_eq!(source.imported_at, Some(1_795_132_800_000));
    let mut fields = entry.fields;
    assert_eq!(fields.category_id.as_deref(), Some(folder.id.as_str()));
    let properties = serde_json::json!([
        {"key":"出处备注","kind":"text","value":"站点文章"},
        {"key":"复读日期","kind":"date","value":"2026-11-19"},
        {"key":"用途","kind":"tags","value":["资料","待阅读"]}
    ]);
    fields.custom_properties = serde_json::from_value(properties.clone()).unwrap();
    let saved = db.save_entry(&id, entry.version, fields, SaveMode::Auto).unwrap();
    let mut fields = db.get_entry(&id).unwrap().fields;
    fields.custom_properties = None;
    db.save_entry(&id, saved.version, fields, SaveMode::Auto).unwrap();
    let mut payload = db.read(|conn| sync::snapshot(conn, &id)).unwrap().unwrap();
    assert_eq!(payload["customProperties"], properties);
    assert_eq!(payload["externalImported"], true);

    let remote = memory();
    payload["categoryId"] = serde_json::Value::Null;
    remote.write(|tx| sync::apply(tx, &id, &payload, None)).unwrap();
    payload.as_object_mut().unwrap().remove("customProperties");
    payload.as_object_mut().unwrap().remove("externalImported");
    remote.write(|tx| sync::apply(tx, &id, &payload, None)).unwrap();
    let remote_entry = remote.get_entry(&id).unwrap();
    assert_eq!(serde_json::to_value(&remote_entry.fields.custom_properties).unwrap(), properties);
    assert_eq!(remote.entries(filter()).unwrap().items[0].id, id);
    let mut edited = remote_entry.fields;
    edited.custom_properties = Some(vec![]);
    remote.save_entry(&id, remote_entry.version, edited, SaveMode::Auto).unwrap();
    assert!(remote.get_entry(&id).unwrap().fields.custom_properties.unwrap().is_empty());

    db.set_deleted(&id, db.get_entry(&id).unwrap().version, true).unwrap();
    assert!(db.entries(filter()).unwrap().items.is_empty());
    assert_eq!(import(), (id, true, true));
}

#[test]
fn timeline_counts_and_filters_live_articles_by_folder_and_tag() {
    let db = memory();
    let parent = db.save_category(None, None, "写作", None, None).unwrap();
    let child = db
        .save_category(None, Some(&parent.id), "草稿", None, None)
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
    let parent = db.save_category(None, None, "文章目录", None, None).unwrap();
    let child = db
        .save_category(None, Some(&parent.id), "子目录", None, None)
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
    let root = db.save_category(None, None, "Notes", None, None).unwrap();
    let child = db
        .save_category(None, Some(&root.id), "Field reports", None, None)
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
                match_page: None,
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
    assert!(find("Alpha [来源:]", false).is_empty());
    assert_eq!(
        find("Alpha [摘要:]", false),
        std::slice::from_ref(&note.row.id)
    );
    assert!(find("file:' OR 1=1 --", false).is_empty());
}

#[test]
fn workspace_search_relevance_ranks_all_results_before_pagination() {
    let db = memory();
    let add = |title, body| {
        db.create_entry(Kind::Article, Some(article(title, body)), None)
            .unwrap()
            .row
            .id
    };
    let fewer = add("A", "检索 可用\n检索\n检索\n检索");
    let more = add("Z", "检索 可用\n检索 可用");
    let partial = add("关于检索", "检索");
    let exact = add("检索", "正文");
    let page = |text: &str, offset, limit| {
        db.entries(Filter {
            sort: Some(EntrySort::Relevance),
            workspace_search: Some(search::WorkspaceSearch {
                text: text.into(),
                case_sensitive: false,
                match_page: None,
            }),
            offset,
            limit: NonZeroU32::new(limit),
            ..Default::default()
        })
        .unwrap()
    };
    let first = page("检索", 0, 1);
    assert_eq!(first.search.unwrap().total, 4);
    assert_eq!(first.next_offset, Some(1));
    assert_eq!(first.items[0].id, exact);
    let rest = page("检索", 1, 3);
    assert_eq!(rest.next_offset, None);
    assert_eq!(
        rest.items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        [partial.as_str(), fewer.as_str(), more.as_str()]
    );
    let scoped = page("line:(检索 可用)", 0, 3);
    assert_eq!(
        scoped
            .items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        [more.as_str(), fewer.as_str()]
    );
    assert_eq!(page("[状态]", 0, 1).items[0].id, fewer);
}

#[test]
fn workspace_search_pages_distinct_lines_and_highlights_source_offsets() {
    let db = memory();
    let line = "😀 **高亮**出现在段落里，高亮再次出现。";
    let prefix = "# 开头\r\n  高亮但不同一行  \r\n";
    let body = format!(
        "{prefix}{}段落但无第二关键词。",
        format!("{line}\r\n").repeat(15)
    );
    let entry = db
        .create_entry(Kind::Article, Some(article("研究入门", &body)), None)
        .unwrap();
    db.create_entry(
        Kind::Article,
        Some(article("高亮 段落", "不匹配的内容")),
        None,
    )
    .unwrap();
    let query = |text: &str, match_page| {
        db.entries(Filter {
            workspace_search: Some(search::WorkspaceSearch {
                text: text.into(),
                case_sensitive: false,
                match_page,
            }),
            limit: NonZeroU32::new(1),
            ..Default::default()
        })
        .unwrap()
    };
    let result = query("line:(高亮 段落)", None);
    assert_eq!(result.search.as_ref().unwrap().total, 1);
    assert_eq!(result.items[0].id, entry.row.id);
    let matches = serde_json::to_value(result.items[0].search_matches.as_ref().unwrap()).unwrap();
    assert_eq!(matches["version"], entry.version);
    assert_eq!(matches["total"], 15);
    assert_eq!(matches["nextOffset"], 12);
    let hit = &matches["items"][0];
    assert_eq!(hit["line"], 3);
    assert_eq!(hit["before"], "  高亮但不同一行  ");
    assert_eq!(hit["text"], line);
    assert!(hit.get("expanded").is_none());
    assert_eq!(hit["start"], prefix.encode_utf16().count());
    assert_eq!(hit["ranges"][0], serde_json::json!({"start":5,"end":7}));
    assert_eq!(hit["ranges"].as_array().unwrap().len(), 3);
    let page = query(
        "line:(高亮 段落)",
        Some(search::MatchPage {
            entry_id: entry.row.id,
            offset: 12,
        }),
    );
    let page = page.items[0].search_matches.as_ref().unwrap();
    assert_eq!(page.items.len(), 3);
    assert_eq!(page.next_offset, None);
    assert_eq!(query("高亮 段落", None).search.unwrap().total, 2);
    assert_eq!(query("content:(高亮 段落)", None).search.unwrap().total, 1);
    assert!(query("line:()", None).items.is_empty());
}

#[test]
fn workspace_search_expands_to_the_full_markdown_line_with_all_highlights() {
    let db = memory();
    let left = format!("  - **开头**{}", "前😀".repeat(130));
    let line = format!(
        "{left}**EdGe**{}{}[^尾词]  ",
        "后😀".repeat(330),
        " eDGE".repeat(610)
    );
    let body = format!("> 上一行\r\n{line}\r\n- 下一行");
    db.create_entry(Kind::Article, Some(article("长行", &body)), None)
        .unwrap();
    let page = db
        .entries(Filter {
            workspace_search: Some(search::WorkspaceSearch {
                text: "line:(edg dge 尾词)".into(),
                case_sensitive: false,
                match_page: None,
            }),
            ..Filter::default()
        })
        .unwrap();
    let matches = serde_json::to_value(page.items[0].search_matches.as_ref().unwrap()).unwrap();
    let hit = &matches["items"][0];
    let expanded = &hit["expanded"];
    let compact_text = hit["text"].as_str().unwrap();
    let expanded_text = expanded["text"].as_str().unwrap();
    assert_eq!(hit["line"], 2);
    assert_eq!(hit["before"], "> 上一行");
    assert_eq!(hit["after"], "- 下一行");
    assert!(expanded_text.contains(compact_text));
    assert!(!compact_text.contains("开头") && !compact_text.contains("尾词"));
    assert_eq!(compact_text.chars().count(), 180);
    assert_eq!(expanded_text, line);
    assert_eq!(expanded["start"], "> 上一行\r\n".encode_utf16().count());
    assert_eq!(expanded["leading"], false);
    assert_eq!(expanded["trailing"], false);

    let expanded_marks: Vec<_> = std::iter::once("EdGe")
        .chain(std::iter::repeat_n("eDGE", 610))
        .chain(std::iter::once("尾词"))
        .collect();

    let source: Vec<_> = body.encode_utf16().collect();
    for (snippet, marks) in [(hit, &["EdGe"][..]), (expanded, expanded_marks.as_slice())] {
        let start = snippet["start"].as_u64().unwrap() as usize;
        let text = snippet["text"].as_str().unwrap();
        assert_eq!(
            String::from_utf16(&source[start..start + text.encode_utf16().count()]).unwrap(),
            text
        );
        let ranges = snippet["ranges"].as_array().unwrap();
        assert_eq!(ranges.len(), marks.len());
        for (range, expected) in ranges.iter().zip(marks) {
            let from = start + range["start"].as_u64().unwrap() as usize;
            let to = start + range["end"].as_u64().unwrap() as usize;
            assert_eq!(String::from_utf16(&source[from..to]).unwrap(), *expected);
        }
    }
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
    let folder = db.save_category(None, None, "目录", None, None).unwrap();
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
    let folder = db.save_category(None, None, "目录", None, None).unwrap();
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
fn timeline_pins_persist_in_their_scope_and_respect_current_membership() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("timeline-pins.db");
    let db = Workspace::open(&path).unwrap();
    let parent = db.save_category(None, None, "文章目录", None, None).unwrap();
    let child = db.save_category(None, Some(&parent.id), "子目录", None, None).unwrap();
    let mut fields = article("文章", "正文");
    fields.category_id = Some(child.id.clone());
    fields.tags.push("微信".into());
    let tagged = db.create_entry(Kind::Article, Some(fields), None).unwrap();
    let root = db.create_entry(Kind::Article, Some(article("根目录文章", "")), None).unwrap();
    let tag_id = db.read(|conn| Ok(conn.query_row("SELECT id FROM tags WHERE name='微信'", [], |row| row.get::<_, String>(0))?)).unwrap();
    let folder_scope = || TimelineSelection::Folder { id: parent.id.clone() };
    let tag_scope = || TimelineSelection::Tag { id: tag_id.clone() };
    let folder_filter = |pinned, exact_category| Filter {
        timeline_scope: Some(folder_scope()),
        pinned: Some(pinned),
        category_id: Some(parent.id.clone()),
        exact_category,
        ..Filter::default()
    };
    let tag_filter = |pinned| Filter {
        timeline_scope: Some(tag_scope()),
        pinned: Some(pinned),
        tag_ids: Some(vec![tag_id.clone()]),
        ..Filter::default()
    };

    db.set_entry_pinned(&tagged.row.id, true).unwrap();
    assert!(!db.entries(folder_filter(false, false)).unwrap().items[0].pinned);
    db.set_timeline_entry_pinned(&tagged.row.id, &folder_scope(), true).unwrap();
    assert_eq!(db.entries(tag_filter(false)).unwrap().items[0].id, tagged.row.id);
    assert!(db.entries(folder_filter(true, true)).unwrap().items.is_empty());
    assert!(db.entries(Filter {
        timeline_scope: Some(TimelineSelection::Folder { id: child.id.clone() }),
        pinned: Some(true),
        category_id: Some(child.id),
        ..Filter::default()
    }).unwrap().items.is_empty());
    db.set_timeline_entry_pinned(&tagged.row.id, &tag_scope(), true).unwrap();
    db.set_timeline_entry_pinned(&root.row.id, &TimelineSelection::Root, true).unwrap();
    assert!(db.entries(Filter {
        timeline_scope: Some(TimelineSelection::Untagged),
        pinned: Some(true),
        untagged: true,
        ..Filter::default()
    }).unwrap().items.is_empty());
    drop(db);

    let db = Workspace::open(&path).unwrap();
    assert_eq!(db.entries(folder_filter(true, false)).unwrap().items[0].id, tagged.row.id);
    assert!(db.entries(folder_filter(false, false)).unwrap().items.is_empty());
    db.set_timeline_entry_pinned(&tagged.row.id, &folder_scope(), false).unwrap();
    assert_eq!(db.entries(folder_filter(false, false)).unwrap().items[0].id, tagged.row.id);
    assert_eq!(db.entries(tag_filter(true)).unwrap().items[0].id, tagged.row.id);
    let directory_pins = db.entries(Filter { pinned: Some(true), ..Filter::default() }).unwrap();
    assert_eq!(directory_pins.items.len(), 1);
    assert_eq!(directory_pins.items[0].id, tagged.row.id);
    db.set_entry_pinned(&tagged.row.id, false).unwrap();
    assert_eq!(db.entries(tag_filter(true)).unwrap().items[0].id, tagged.row.id);
    db.set_deleted(&tagged.row.id, tagged.version, true).unwrap();
    assert!(db.entries(tag_filter(true)).unwrap().items.is_empty());
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
    let root = db.save_category(None, None, "选题", None, None).unwrap().id;
    let child = db
        .save_category(None, Some(&root), "访谈", None, None)
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
        db.save_category(None, Some(&child), "第三级", None, None)
            .is_err()
    );
    assert!(db.save_category(None, Some(&root), "访谈", None, None).is_err());
    db.delete_category(&child, crate::content::taxonomy::CategoryDeleteMode::Promote).unwrap();
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
    let parent = db.save_category(None, None, "收集", None, None).unwrap();
    assert_eq!(parent.icon, CategoryIcon::Folder);
    let child = db
        .save_category(
            None,
            Some(&parent.id),
            "剪辑",
            Some(CategoryIcon::Newspaper),
            None,
        )
        .unwrap();
    assert_eq!(serde_json::to_value(&child).unwrap()["icon"], "newspaper");
    let renamed = db
        .save_category(Some(&child.id), None, "编辑", None, None)
        .unwrap();
    assert_eq!(renamed.id, child.id);
    assert_eq!(renamed.parent_id.as_deref(), Some(parent.id.as_str()));
    assert_eq!(renamed.icon, CategoryIcon::Newspaper);
    let icon = serde_json::from_value(serde_json::json!("bookmark")).unwrap();
    db.save_category(Some(&child.id), None, "编辑", Some(icon), None)
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
        .save_category(Some("nested"), None, "项目", Some(CategoryIcon::Rocket), None)
        .unwrap();
    assert_eq!(edited.parent_id.as_deref(), Some("first"));
    assert_eq!(edited.icon, CategoryIcon::Rocket);
}

#[test]
fn moving_categories_uses_visible_neighbors_when_sort_orders_tie() {
    for parent in [None, Some("parent")] {
        let db = memory();
        db.write(|tx| {
            tx.execute_batch("DELETE FROM categories;
                INSERT INTO categories (id,name,depth,sort_order) VALUES ('parent','父目录',1,50),('other','其他目录',1,60);
                INSERT INTO categories (id,name,parent_id,depth,sort_order) VALUES ('untouched','不移动','other',2,9);")?;
            for (id, name) in [("a", "甲"), ("b", "乙"), ("c", "丙")] {
                tx.execute("INSERT INTO categories (id,name,parent_id,depth,sort_order) VALUES (?1,?2,?3,?4,0)",
                    params![id, name, parent, if parent.is_some() { 2 } else { 1 }])?;
            }
            Ok(())
        }).unwrap();
        let order = || {
            db.read(|conn| {
            Ok(conn.prepare("SELECT id FROM categories WHERE parent_id IS ?1 AND id IN ('a','b','c') ORDER BY sort_order,id")?
                .query_map([parent], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?)
        }).unwrap()
        };
        db.move_category("b", true).unwrap();
        assert_eq!(order(), ["b", "a", "c"]);
        db.move_category("c", true).unwrap();
        assert_eq!(order(), ["b", "c", "a"]);
        db.move_category("b", true).unwrap();
        assert_eq!(order(), ["b", "c", "a"]);
        db.move_category("b", false).unwrap();
        assert_eq!(order(), ["c", "b", "a"]);
        let before = serde_json::to_value(db.library().unwrap().categories).unwrap();
        db.move_category(if parent.is_some() { "a" } else { "other" }, false)
            .unwrap();
        assert_eq!(
            serde_json::to_value(db.library().unwrap().categories).unwrap(),
            before
        );
        db.read(|conn| {
            let (count, distinct): (i64, i64) = conn.query_row(
                "SELECT COUNT(*),COUNT(DISTINCT sort_order) FROM categories WHERE parent_id IS ?1",
                [parent],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(count, distinct);
            assert_eq!(
                conn.query_row(
                    "SELECT sort_order FROM categories WHERE id='untouched'",
                    [],
                    |row| row.get::<_, i64>(0)
                )?,
                9
            );
            Ok(())
        })
        .unwrap();
    }
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
    db.save_category(Some(&library.categories[0].id), None, "文章草稿", None, None)
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
    let root = db.save_category(None, None, "选题", None, None).unwrap().id;
    let child = db
        .save_category(None, Some(&root), "子选题", None, None)
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


#[test]
fn deleting_a_folder_promotes_children_and_preserves_document_locations() {
    let db = memory();
    let root = db.save_category(None, None, "parent", None, None).unwrap().id;
    let child = db
        .save_category(None, Some(&root), "child", None, None)
        .unwrap()
        .id;
    let sibling = db.save_category(None, None, "child", None, None).unwrap().id;
    let mut fields = article("direct", "kept");
    fields.category_id = Some(root.clone());
    let direct = db.create_entry(Kind::Article, Some(fields), None).unwrap();
    let mut fields = article("nested", "kept nested");
    fields.category_id = Some(child.clone());
    let nested = db.create_entry(Kind::Article, Some(fields), None).unwrap();
    let changed = db
        .delete_category(&root, taxonomy::CategoryDeleteMode::Promote)
        .unwrap();
    assert_eq!(changed.len(), 1);
    assert_eq!(
        serde_json::to_value(&changed[0]).unwrap()["id"],
        direct.row.id
    );
    assert!(
        db.get_entry(&direct.row.id)
            .unwrap()
            .fields
            .category_id
            .is_none()
    );
    let nested = db.get_entry(&nested.row.id).unwrap();
    assert_eq!(nested.fields.category_id.as_deref(), Some(child.as_str()));
    assert!(nested.row.deleted_at.is_none());
    let categories = db.library().unwrap().categories;
    assert!(!categories.iter().any(|item| item.id == root));
    let promoted = categories.iter().find(|item| item.id == child).unwrap();
    assert!(promoted.parent_id.is_none());
    assert_eq!(serde_json::to_value(promoted).unwrap()["name"], "child (2)");
    let sibling = categories.iter().find(|item| item.id == sibling).unwrap();
    assert_eq!(serde_json::to_value(sibling).unwrap()["name"], "child");
    // Promoted folders really become roots and can accept a child of their own.
    db.save_category(None, Some(&child), "new child", None, None)
        .unwrap();
}

#[test]
fn deleting_a_child_folder_moves_its_documents_to_its_parent() {
    let db = memory();
    let parent = db.save_category(None, None, "parent", None, None).unwrap().id;
    let child = db
        .save_category(None, Some(&parent), "child", None, None)
        .unwrap()
        .id;
    let mut fields = article("direct", "preserved");
    fields.category_id = Some(child.clone());
    let entry = db.create_entry(Kind::Article, Some(fields), None).unwrap();
    db.delete_category(&child, taxonomy::CategoryDeleteMode::Promote)
        .unwrap();
    let entry = db.get_entry(&entry.row.id).unwrap();
    assert_eq!(entry.fields.category_id.as_deref(), Some(parent.as_str()));
    assert_eq!(entry.fields.content_md, "preserved");
    assert!(entry.row.deleted_at.is_none());
}

#[test]
fn deleting_folder_contents_trashes_all_documents_and_keeps_existing_deletion_age() {
    let db = memory();
    let root = db.save_category(None, None, "parent", None, None).unwrap().id;
    let child = db
        .save_category(None, Some(&root), "child", None, None)
        .unwrap()
        .id;
    let outside = db
        .create_entry(Kind::Article, Some(article("outside", "keep")), None)
        .unwrap();
    let mut ids = Vec::new();
    for category in [&root, &child] {
        let mut fields = article("inside", "recoverable");
        fields.category_id = Some(category.clone());
        ids.push(
            db.create_entry(Kind::Article, Some(fields), None)
                .unwrap()
                .row
                .id,
        );
    }
    db.write(|tx| {
        tx.execute("UPDATE entries SET deleted_at=123 WHERE id=?1", [&ids[1]])?;
        Ok(())
    })
    .unwrap();
    let changed = db
        .delete_category(&root, taxonomy::CategoryDeleteMode::Trash)
        .unwrap();
    assert_eq!(changed.len(), 2);
    for id in &ids {
        let entry = db.get_entry(id).unwrap();
        assert!(entry.row.deleted_at.is_some());
        assert!(entry.fields.category_id.is_none());
        assert_eq!(entry.fields.content_md, "recoverable");
    }
    assert_eq!(db.get_entry(&ids[1]).unwrap().row.deleted_at, Some(123));
    assert!(
        db.get_entry(&outside.row.id)
            .unwrap()
            .row
            .deleted_at
            .is_none()
    );
    assert!(
        !db.library()
            .unwrap()
            .categories
            .iter()
            .any(|item| item.id == root || item.id == child)
    );
}

#[test]
fn failed_folder_delete_rolls_back_promotions_and_documents() {
    let db = memory();
    let root = db.save_category(None, None, "parent", None, None).unwrap().id;
    let child = db
        .save_category(None, Some(&root), "child", None, None)
        .unwrap()
        .id;
    let mut fields = article("direct", "kept");
    fields.category_id = Some(root.clone());
    let entry = db.create_entry(Kind::Article, Some(fields), None).unwrap();
    db.write(|tx| { tx.execute_batch("CREATE TRIGGER fail_folder_delete BEFORE DELETE ON categories BEGIN SELECT RAISE(ABORT,'test failure'); END;")?; Ok(()) }).unwrap();
    assert!(
        db.delete_category(&root, taxonomy::CategoryDeleteMode::Promote)
            .is_err()
    );
    assert_eq!(
        db.get_entry(&entry.row.id)
            .unwrap()
            .fields
            .category_id
            .as_deref(),
        Some(root.as_str())
    );
    assert_eq!(
        db.library()
            .unwrap()
            .categories
            .iter()
            .find(|item| item.id == child)
            .unwrap()
            .parent_id
            .as_deref(),
        Some(root.as_str())
    );
}

#[test]
fn promoting_a_same_named_child_keeps_its_name() {
    let db = memory();
    let parent = db.save_category(None, None, "same name", None, None).unwrap().id;
    let child = db
        .save_category(None, Some(&parent), "same name", None, None)
        .unwrap()
        .id;
    db.delete_category(&parent, taxonomy::CategoryDeleteMode::Promote)
        .unwrap();
    let categories = serde_json::to_value(db.library().unwrap().categories).unwrap();
    let promoted = categories
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == child)
        .unwrap();
    assert_eq!(promoted["name"], "same name");
    assert!(promoted["parentId"].is_null());
}

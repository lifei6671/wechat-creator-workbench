use super::*;
use crate::{
    content::{Entry, EntryPatch, EntrySort, Filter, Kind, Page, SaveMode},
    db::Workspace,
};
use std::num::NonZeroU32;

fn memory() -> Workspace {
    Workspace::open(std::path::Path::new(":memory:")).unwrap()
}

fn add(db: &Workspace, title: &str, body: &str) -> Entry {
    db.create_external(
        Kind::Article,
        EntryPatch {
            title: Some(title.into()),
            content_md: Some(body.into()),
            status: Some("draft".into()),
            ..EntryPatch::default()
        },
    )
    .unwrap()
}

fn filter(text: &str) -> Filter {
    Filter {
        workspace_search: Some(WorkspaceSearch {
            text: text.into(),
            case_sensitive: false,
            match_page: None,
        }),
        sort: Some(EntrySort::Relevance),
        ..Filter::default()
    }
}

fn find(db: &Workspace, text: &str) -> Page {
    db.entries(filter(text)).unwrap()
}

#[test]
fn segmented_search_preserves_quoted_and_scoped_literal_contracts() {
    let db = memory();
    let expanded = add(&db, "研究", "# 方法\n公众号\n排版技巧");
    let literal = add(&db, "原文", "公众号排版");
    let page = find(&db, "公众号排版");
    assert_eq!(page.search.unwrap().total, 2);
    assert_eq!(
        page.items.iter().map(|e| &e.id).collect::<Vec<_>>(),
        [&literal.row.id, &expanded.row.id]
    );
    assert_eq!(find(&db, "\"公众号排版\"").items[0].id, literal.row.id);
    assert_eq!(find(&db, "\"公众号排版\"").items.len(), 1);
    assert_eq!(find(&db, "content:公众号排版").items.len(), 1);
    assert!(find(&db, "file:公众号排版").items.is_empty());
    assert_eq!(find(&db, "line:(公众号 排版)").items.len(), 1);
    assert_eq!(find(&db, "section:(公众号 排版)").items.len(), 2);
    assert!(find(&db, "公众号 OR 排版").items.is_empty());
    let mut sensitive = filter("公众号排版");
    sensitive.workspace_search.as_mut().unwrap().case_sensitive = true;
    assert_eq!(db.entries(sensitive).unwrap().items.len(), 1);
    assert_eq!(
        db.entries(Filter {
            query: Some("公众号排版".into()),
            ..Filter::default()
        })
        .unwrap()
        .items
        .len(),
        1
    );
}

#[test]
fn segmented_highlights_use_original_utf16_and_whole_tokens() {
    let db = memory();
    let body = "😀公众号\r\nlayout\nlayoutExtra\n";
    let entry = add(&db, "研究", body);
    let page = find(&db, "公众号layout");
    assert_eq!(page.items[0].id, entry.row.id);
    let matches = page.items[0].search_matches.as_ref().unwrap();
    assert_eq!(matches.total, 2);
    let source: Vec<_> = body.encode_utf16().collect();
    let mut highlighted = Vec::new();
    for hit in &matches.items {
        for range in &hit.snippet.ranges {
            highlighted.push(
                String::from_utf16(
                    &source[hit.snippet.start + range.start..hit.snippet.start + range.end],
                )
                .unwrap(),
            );
        }
    }
    assert_eq!(highlighted.concat(), "公众号layout");
    assert!(matches.items.iter().all(|hit| hit.line != 3));

    let unicode = add(&db, "Unicode", "😀İ CAFÉ WES-5.4.5");
    let page = find(&db, "content:İ");
    assert_eq!(page.items[0].id, unicode.row.id);
    let hit = &page.items[0].search_matches.as_ref().unwrap().items[0];
    assert_eq!(hit.snippet.ranges[0], 2..3);
    assert_eq!(find(&db, "café WES").items[0].id, unicode.row.id);
    assert!(find(&db, "cafe WES").items.is_empty());
    assert_eq!(find(&db, "content:\u{0307}").items[0].id, unicode.row.id);
}

#[test]
fn word_index_updates_roll_back_and_purge_without_body_changes() {
    let db = memory();
    let entry = add(&db, "方法", "公众号排版");
    let count = |text: &str| {
        db.read(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM entries_words_fts WHERE entries_words_fts MATCH ?1",
                [text],
                |row| row.get::<_, i64>(0),
            )?)
        })
        .unwrap()
    };
    assert_eq!(count("\"排版\""), 1);
    let mut fields = entry.fields;
    fields.content_md = "离线写作".into();
    let saved = db
        .save_entry(&entry.row.id, entry.version, fields, SaveMode::Auto)
        .unwrap();
    assert_eq!(count("\"排版\""), 0);
    assert_eq!(count("\"写作\""), 1);
    db.write(|tx| {
        tx.execute_batch(
            "CREATE TRIGGER reject_search_write AFTER UPDATE ON entries
            WHEN new.content_md='should fail' BEGIN SELECT RAISE(ABORT,'test'); END;",
        )?;
        Ok(())
    })
    .unwrap();
    assert!(
        db.write(|tx| {
            tx.execute(
                "UPDATE entries SET content_md='should fail' WHERE id=?1",
                [&entry.row.id],
            )?;
            Ok(())
        })
        .is_err()
    );
    assert_eq!(count("\"写作\""), 1);
    db.set_deleted(&entry.row.id, saved.version, true).unwrap();
    db.write(|tx| {
        tx.execute(
            "UPDATE entries SET purged_at=10 WHERE id=?1",
            [&entry.row.id],
        )?;
        Ok(())
    })
    .unwrap();
    assert_eq!(count("\"写作\""), 0);
    assert!(find(&db, "离线写作").items.is_empty());
    let physical = add(&db, "删除", "公众号排版");
    db.write(|tx| {
        tx.execute("DELETE FROM entries WHERE id=?1", [&physical.row.id])?;
        Ok(())
    })
    .unwrap();
    assert_eq!(count("\"排版\""), 0);
}

#[test]
fn bm25_ranks_short_relevant_content_before_long_repetition_and_pages_globally() {
    let db = memory();
    let long = add(&db, "A", &format!("排版\n{}", "无关内容 ".repeat(500)));
    let short = add(&db, "Z", "排版");
    let exact = add(&db, "排版", "正文");
    let mut first = filter("排版");
    first.limit = NonZeroU32::new(1);
    let page = db.entries(first).unwrap();
    assert_eq!(page.search.unwrap().total, 3);
    assert_eq!(page.items[0].id, exact.row.id);
    let mut rest = filter("排版");
    rest.offset = 1;
    let page = db.entries(rest).unwrap();
    assert_eq!(
        page.items.iter().map(|e| &e.id).collect::<Vec<_>>(),
        [&short.row.id, &long.row.id]
    );
}

#[test]
fn segmented_matches_page_distinct_lines_with_stable_filters() {
    let db = memory();
    let entry = add(
        &db,
        "公众号",
        &(0..18).map(|n| format!("排版 {n}\n")).collect::<String>(),
    );
    let mut query = filter("公众号排版");
    let page = db.entries(query).unwrap();
    assert_eq!(page.search.unwrap().total, 1);
    let hits = page.items[0].search_matches.as_ref().unwrap();
    assert_eq!(hits.total, 18);
    assert_eq!(hits.next_offset, Some(12));
    query = filter("公众号排版");
    query.workspace_search.as_mut().unwrap().match_page = Some(MatchPage {
        entry_id: entry.row.id,
        offset: 12,
    });
    let page = db.entries(query).unwrap();
    let hits = page.items[0].search_matches.as_ref().unwrap();
    assert_eq!(hits.items.len(), 6);
    assert_eq!(hits.items[0].line, 13);
    assert_eq!(hits.next_offset, None);
    let mut hidden = filter("公众号排版");
    hidden.status = Some("published".into());
    assert!(db.entries(hidden).unwrap().items.is_empty());
}

#[test]
#[ignore = "manual synthetic search and index-rebuild benchmark"]
fn search_benchmark() {
    use std::time::Instant;
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("bench.db");
    let mut db = Workspace::open(&path).unwrap();
    let body: String = "写作方法和技术资料整理。离线编辑保存，检索文章内容。\n"
        .chars()
        .cycle()
        .take(5000)
        .collect();
    let mut previous = 0;
    for size in [1000, 10000] {
        let started = Instant::now();
        db.write(|tx| {
            let mut insert = tx.prepare(
                "INSERT INTO entries(id,kind,title,content_md,status,created_at,updated_at)
                VALUES(?1,'article',?2,?3,'draft',0,0)",
            )?;
            for n in previous..size {
                let text = format!(
                    "{}\n{}",
                    if n == 0 {
                        "公众号排版"
                    } else if n % 5 == 0 {
                        "排版技巧"
                    } else {
                        "写作练习"
                    },
                    if n == 0 {
                        body.repeat(10)
                    } else {
                        body.clone()
                    }
                );
                insert.execute(rusqlite::params![
                    format!("bench-{n}"),
                    format!("公众号研究 {n}"),
                    text
                ])?;
            }
            Ok(())
        })
        .unwrap();
        eprintln!(
            "BENCH size={size} incremental_insert_ms={}",
            started.elapsed().as_millis()
        );
        db.write(|tx| {
            tx.execute(
                "UPDATE search_index_state SET signature='benchmark-rebuild' WHERE id=1",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        drop(db);
        let mut conn = rusqlite::Connection::open(&path).unwrap();
        search_index::register(&conn).unwrap();
        let started = Instant::now();
        search_index::rebuild_for_test(&mut conn).unwrap();
        let rebuild_ms = started.elapsed().as_millis();
        drop(conn);
        let started = Instant::now();
        db = Workspace::open(&path).unwrap();
        let open_ms = started.elapsed().as_millis();
        for text in [
            "公众号排版",
            "\"公众号排版\"",
            "公众号 排版",
            "排版",
            "公",
            "file:公众号研究",
            "不可能出现的专有查询",
        ] {
            let parsed = WorkspaceSearch {
                text: text.into(),
                case_sensitive: false,
                match_page: None,
            }
            .parse(false);
            let words = parsed.score_words();
            let (literal, word, overlap) = db.read(|conn| {
                let table = search_index::state(conn)?.table.expect("benchmark word index ready");
                let mut literal_query = "SELECT e.rowid FROM entries e WHERE e.purged_at IS NULL AND e.deleted_at IS NULL".to_string();
                let mut literal_values = Vec::new();
                parsed.apply(conn, &mut literal_query, &mut literal_values)?;
                let literal: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM ({literal_query})"), rusqlite::params_from_iter(&literal_values), |r| r.get(0))?;
                let (word, overlap) = if words.is_empty() { (0,0) } else {
                    let word_query = search_index::match_query(&words, " AND ");
                    let word = conn.query_row(&format!("SELECT COUNT(*) FROM {table} WHERE {table} MATCH ?1"), [&word_query], |r| r.get::<_, i64>(0))?;
                    let values: Vec<_> = std::iter::once(Value::Text(word_query.clone())).chain(literal_values.iter().cloned()).collect();
                    let overlap = conn.query_row(&format!("SELECT COUNT(*) FROM {table} WHERE {table} MATCH ? AND rowid IN ({literal_query})"), rusqlite::params_from_iter(values), |r| r.get::<_, i64>(0))?;
                    (word,overlap)
                };
                Ok((literal,word,overlap))
            }).unwrap();
            let first = Instant::now();
            let page = find(&db, text);
            let first_ms = first.elapsed().as_millis();
            let total = page.search.unwrap().total;
            let mut durations = Vec::new();
            for _ in 0..20 {
                let start = Instant::now();
                assert_eq!(find(&db, text).search.unwrap().total, total);
                durations.push(start.elapsed().as_millis());
            }
            durations.sort_unstable();
            eprintln!(
                "BENCH size={size} query={text:?} literal={literal} word={word} overlap={overlap} final={total} first_ms={first_ms} p50_ms={} p95_ms={} rebuild_ms={rebuild_ms} open_ms={open_ms} db_bytes={}",
                durations[9],
                durations[18],
                std::fs::metadata(&path).unwrap().len()
            );
        }
        previous = size;
    }
}

#[test]
#[ignore = "manual background rebuild and foreground editor-save benchmark"]
fn background_rebuild_benchmark() {
    use std::{
        sync::mpsc,
        time::{Duration, Instant},
    };
    let root = tempfile::tempdir().unwrap();
    let body: String = "写作方法和技术资料整理。离线编辑保存，检索文章内容。\n"
        .chars()
        .cycle()
        .take(5000)
        .collect();
    for size in [1000, 10000] {
        let path = root.path().join(format!("background-{size}.db"));
        let db = Workspace::open(&path).unwrap();
        db.write(|tx| {
            let mut insert = tx.prepare(
                "INSERT INTO entries(id,kind,title,content_md,status,created_at,updated_at)
                VALUES(?1,'article',?2,?3,'draft',0,0)",
            )?;
            for n in 0..size {
                insert.execute(rusqlite::params![
                    format!("bench-{n}"),
                    format!("公众号研究 {n}"),
                    format!(
                        "排版技巧\n{}",
                        if n == 0 {
                            body.repeat(10)
                        } else {
                            body.clone()
                        }
                    )
                ])?;
            }
            Ok(())
        })
        .unwrap();
        let mut probe = add(&db, "编辑中的草稿", "后台保存 初稿");
        let probe_id = probe.row.id.clone();
        let mut baseline = Vec::new();
        for n in 0..20 {
            probe.fields.content_md = format!("后台保存 baseline {n}");
            let saving = Instant::now();
            db.save_entry(&probe_id, probe.version, probe.fields, SaveMode::Auto)
                .unwrap();
            baseline.push(saving.elapsed().as_secs_f64() * 1000.0);
            probe = db.get_entry(&probe_id).unwrap();
        }
        baseline.sort_by(f64::total_cmp);
        db.write(|tx| {
            tx.execute(
                "UPDATE search_index_state SET signature='benchmark-background' WHERE id=1",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        let pending = find(&db, "公众号排版");
        assert!(pending.search.as_ref().unwrap().indexing);
        let pending_generation = pending.search.unwrap().index_generation;
        let (send, receive) = mpsc::channel();
        let started = Instant::now();
        db.start_search_index(move || {
            let _ = send.send(());
        })
        .unwrap();
        let scheduling_ms = started.elapsed().as_secs_f64() * 1000.0;
        let mut saves = Vec::new();
        loop {
            if receive.try_recv().is_ok() {
                break;
            }
            assert!(
                started.elapsed() < Duration::from_secs(120),
                "background benchmark timed out"
            );
            probe.fields.content_md = format!("后台保存 {}", saves.len());
            let saving = Instant::now();
            db.save_entry(&probe_id, probe.version, probe.fields, SaveMode::Auto)
                .unwrap();
            saves.push(saving.elapsed().as_secs_f64() * 1000.0);
            probe = db.get_entry(&probe_id).unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
        let elapsed_ms = started.elapsed().as_millis();
        assert_eq!(db.search_index_error(), None);
        assert!(!saves.is_empty());
        let ready = find(&db, "公众号排版");
        let ready = ready.search.unwrap();
        assert!(!ready.indexing);
        assert_ne!(ready.index_generation, pending_generation);
        assert_eq!(ready.total, size);
        db.read(|conn| {
            let table = search_index::state(conn)?
                .table
                .expect("background index ready");
            let query =
                search_index::match_query(&search_index::words(&probe.fields.content_md), " AND ");
            let latest: i64 = conn.query_row(
                &format!(
                    "SELECT count(*) FROM {table}
                WHERE rowid=(SELECT rowid FROM entries WHERE id=?1) AND {table} MATCH ?2"
                ),
                rusqlite::params![probe_id, query],
                |r| r.get(0),
            )?;
            assert_eq!(latest, 1, "cutover must include the latest editor save");
            assert_eq!(
                conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))?,
                size + 1
            );
            Ok(())
        })
        .unwrap();
        saves.sort_by(f64::total_cmp);
        let p50 = saves[(saves.len() - 1) / 2];
        let p95 = saves[(saves.len() * 95).div_ceil(100) - 1];
        eprintln!(
            "BACKGROUND size={size} schedule_ms={scheduling_ms:.2} elapsed_ms={elapsed_ms} saves={} save_p50_ms={p50:.2} save_p95_ms={p95:.2} save_max_ms={:.2} baseline_save_p50_ms={:.2} baseline_save_p95_ms={:.2}",
            saves.len(),
            saves[saves.len() - 1],
            baseline[9],
            baseline[18]
        );
    }
}

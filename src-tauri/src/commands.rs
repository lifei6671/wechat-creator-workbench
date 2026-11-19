use crate::{
    ai::AiService,
    assets::Assets,
    content::{
        Entry, Fields, Filter, Kind, Page, Revision, SaveMode, SaveResult, TimelineSelection,
        taxonomy::{Category, CategoryChange, CategoryIcon, CategoryPlacement, Library},
    },
    db::{AppError, Result, Workspace},
    mcp::McpServer,
};
use pulldown_cmark::{Event, HeadingLevel, Parser, Tag, TagEnd};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn library(
    state: State<'_, Workspace>,
    include_article_counts: Option<bool>,
) -> Result<Library> {
    if include_article_counts == Some(true) {
        state.library_with_article_counts(true)
    } else {
        state.library()
    }
}

#[tauri::command]
pub async fn entries(state: State<'_, Workspace>, filter: Filter) -> Result<Page> {
    state.entries(filter)
}

#[tauri::command]
pub async fn get_entry(state: State<'_, Workspace>, id: String) -> Result<Entry> {
    state.get_entry(&id)?.with_github_images()
}

#[tauri::command]
pub async fn create_entry(
    state: State<'_, Workspace>,
    kind: Kind,
    fields: Option<Fields>,
    source_entry_id: Option<String>,
) -> Result<Entry> {
    state.create_entry(kind, fields, source_entry_id)
}

#[tauri::command]
pub async fn import_markdown(
    app: AppHandle,
    state: State<'_, Workspace>,
    assets: State<'_, Assets>,
    category_id: Option<String>,
) -> Result<Option<ImportedMarkdown>> {
    let dialog = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"]);
    let selected = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file())
        .await
        .map_err(|error| AppError::new("IMPORT_FAILED", error.to_string()))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| AppError::new("IMPORT_FAILED", error.to_string()))?;
    let markdown = crate::clipboard::read_markdown_file(&path)?;
    let (title, body) = import_title(&markdown).unwrap_or_else(|| {
        let name = path.file_stem().expect("selected Markdown file has a name");
        (name.to_string_lossy().into_owned(), &markdown)
    });
    let (body, unavailable_images) = assets
        .import_markdown_images(
            &state,
            body,
            path.parent().expect("selected Markdown file has a parent"),
        )
        .await?;
    let entry = state.create_external(
        Kind::Article,
        crate::content::EntryPatch {
            title: Some(title),
            content_md: Some(body),
            category_id: Some(category_id),
            ..Default::default()
        },
    )?;
    let _ = app.emit("assets-changed", ());
    Ok(Some(ImportedMarkdown {
        entry,
        unavailable_images,
    }))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedMarkdown {
    entry: Entry,
    unavailable_images: usize,
}

fn import_title(markdown: &str) -> Option<(String, &str)> {
    let line_end = markdown.find(['\r', '\n']).unwrap_or(markdown.len());
    let after_marker = markdown[..line_end]
        .trim_start_matches(' ')
        .strip_prefix('#')?;
    if !after_marker.starts_with([' ', '\t']) {
        return None;
    }
    let mut events = Parser::new(markdown);
    if !matches!(
        events.next(),
        Some(Event::Start(Tag::Heading {
            level: HeadingLevel::H1,
            ..
        }))
    ) {
        return None;
    }
    let mut title = String::new();
    for event in events.take_while(|event| !matches!(event, Event::End(TagEnd::Heading(_)))) {
        if let Event::Text(text) | Event::Code(text) = event {
            title.push_str(&text);
        }
    }
    let title = title.trim();
    (!title.is_empty()).then(|| {
        (
            title.to_owned(),
            markdown[line_end..].trim_start_matches(['\r', '\n']),
        )
    })
}

#[tauri::command]
pub async fn save_entry(
    state: State<'_, Workspace>,
    id: String,
    expected_version: i64,
    fields: Fields,
    mode: SaveMode,
) -> Result<SaveResult> {
    state.save_entry(&id, expected_version, fields, mode)
}

#[tauri::command]
pub async fn set_deleted(
    state: State<'_, Workspace>,
    id: String,
    expected_version: i64,
    deleted: bool,
) -> Result<Entry> {
    state.set_deleted(&id, expected_version, deleted)
}

#[tauri::command]
pub async fn save_category(
    state: State<'_, Workspace>,
    id: Option<String>,
    parent_id: Option<String>,
    name: String,
    icon: Option<CategoryIcon>,
) -> Result<Category> {
    state.save_category(id.as_deref(), parent_id.as_deref(), &name, icon)
}

#[tauri::command]
pub async fn delete_category(
    state: State<'_, Workspace>,
    id: String,
) -> Result<Vec<CategoryChange>> {
    state.delete_category(&id)
}

#[tauri::command]
pub async fn move_category(state: State<'_, Workspace>, id: String, up: bool) -> Result<()> {
    state.move_category(&id, up)
}

#[tauri::command]
pub async fn reorder_category(
    state: State<'_, Workspace>,
    id: String,
    anchor: String,
    placement: CategoryPlacement,
) -> Result<()> {
    state.reorder_category(&id, &anchor, placement)
}

#[tauri::command]
pub async fn set_entry_pinned(
    state: State<'_, Workspace>,
    id: String,
    pinned: bool,
    timeline_scope: Option<TimelineSelection>,
) -> Result<()> {
    match timeline_scope {
        Some(scope) => state.set_timeline_entry_pinned(&id, &scope, pinned),
        None => state.set_entry_pinned(&id, pinned),
    }
}

#[tauri::command]
pub async fn reorder_entry(
    state: State<'_, Workspace>,
    id: String,
    anchor: String,
    placement: CategoryPlacement,
) -> Result<()> {
    state.reorder_entry(&id, &anchor, placement)
}

#[tauri::command]
pub async fn revisions(state: State<'_, Workspace>, id: String) -> Result<Vec<Revision>> {
    state.revisions(&id)
}

#[tauri::command]
pub async fn export_markdown(
    app: AppHandle,
    state: State<'_, Workspace>,
    assets: State<'_, crate::assets::Assets>,
    id: String,
) -> Result<Option<String>> {
    let (title, markdown) = state.export_text(&id)?;
    let file_name: String = title
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_control() || "/\\:*?\"<>|".contains(ch) {
                '_'
            } else {
                ch
            }
        })
        .take(100)
        .collect();
    let file_name = if file_name.is_empty() {
        "未命名"
    } else {
        &file_name
    };
    let Some(path) =
        crate::assets::publishing::destination(&app, "Markdown", "md", &format!("{file_name}.md"))
            .await?
    else {
        return Ok(None);
    };
    assets
        .export_markdown_file(&state, &markdown, &path)
        .await?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn begin_exit(
    state: State<'_, Workspace>,
    assets: State<'_, crate::assets::Assets>,
    mcp: State<'_, McpServer>,
    ai: State<'_, AiService>,
) -> Result<()> {
    state.begin_exit();
    assets.kick();
    tokio::join!(mcp.suspend(), ai.stop());
    Ok(())
}

#[tauri::command]
pub async fn cancel_exit(
    app: AppHandle,
    state: State<'_, Workspace>,
    assets: State<'_, crate::assets::Assets>,
    mcp: State<'_, McpServer>,
) -> Result<()> {
    state.cancel_exit();
    assets.kick();
    mcp.resume(&app, &state).await;
    Ok(())
}

#[tauri::command]
pub async fn finish_exit(
    app: AppHandle,
    state: State<'_, Workspace>,
    assets: State<'_, crate::assets::Assets>,
) -> Result<()> {
    state.start_cleaning();
    if let Err(error) = assets.cleanup(&state).await {
        eprintln!("素材清理失败：{error}");
    }
    state.finish_exit();
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::import_title;

    #[test]
    fn markdown_import_promotes_only_a_first_line_h1() {
        let input = "# **导入标题** 与 `代码` ###\r\n\r\n正文\r\n\r\n# 下一个标题\r\n";
        assert_eq!(
            import_title(input),
            Some(("导入标题 与 代码".into(), "正文\r\n\r\n# 下一个标题\r\n"))
        );
        assert_eq!(import_title("# 标题"), Some(("标题".into(), "")));
        assert_eq!(
            import_title("# [安装指南][setup]\n\n[setup]: https://example.com"),
            Some(("安装指南".into(), "[setup]: https://example.com"))
        );
        for input in ["\n# 次行", "## 二级标题", "#hashtag\n===", "#", "标题\n==="] {
            assert_eq!(import_title(input), None);
        }
    }
}

use crate::content::collections::{
    CanvasEdge, CanvasNode, Collection, CollectionCanvas, NodeContent, NodeGeometry, Position,
    Viewport,
};

#[tauri::command]
pub async fn list_collections(state: State<'_, Workspace>) -> Result<Vec<Collection>> {
    state.list_collections()
}

#[tauri::command]
pub async fn save_collection(
    state: State<'_, Workspace>,
    id: Option<String>,
    title: String,
    description: String,
) -> Result<Collection> {
    state.save_collection(id.as_deref(), &title, &description)
}

#[tauri::command]
pub async fn delete_collection(
    app: AppHandle,
    state: State<'_, Workspace>,
    id: String,
) -> Result<()> {
    state.delete_collection(&id)?;
    crate::canvas_preview_cache::delete(&app, &id, None).await;
    Ok(())
}

#[tauri::command]
pub async fn get_collection_canvas(
    state: State<'_, Workspace>,
    collection_id: String,
) -> Result<CollectionCanvas> {
    state.collection_canvas(&collection_id)
}

#[tauri::command]
pub async fn create_collection_node(
    state: State<'_, Workspace>,
    collection_id: String,
    content: NodeContent,
    position: Position,
) -> Result<CanvasNode> {
    state.create_collection_node(&collection_id, content, position)
}

#[tauri::command]
pub async fn update_collection_node_text(
    state: State<'_, Workspace>,
    node_id: String,
    content_md: String,
) -> Result<()> {
    state.update_collection_node_text(&node_id, &content_md)
}

#[tauri::command]
pub async fn update_collection_node_color(
    state: State<'_, Workspace>,
    node_id: String,
    color: Option<String>,
) -> Result<()> {
    state.update_collection_node_color(&node_id, color.as_deref())
}

#[tauri::command]
pub async fn update_collection_node_geometry(
    state: State<'_, Workspace>,
    updates: Vec<NodeGeometry>,
) -> Result<()> {
    state.update_collection_node_geometry(updates)
}

#[tauri::command]
pub async fn delete_collection_node(
    app: AppHandle,
    state: State<'_, Workspace>,
    node_id: String,
) -> Result<()> {
    if let Some(collection_id) = state.delete_collection_node(&node_id)? {
        crate::canvas_preview_cache::delete(&app, &collection_id, Some(&node_id)).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn convert_collection_text(
    state: State<'_, Workspace>,
    node_id: String,
) -> Result<CanvasNode> {
    state.convert_collection_text(&node_id)
}

#[tauri::command]
pub async fn create_collection_edge(
    state: State<'_, Workspace>,
    collection_id: String,
    source_node_id: String,
    target_node_id: String,
    label: String,
) -> Result<CanvasEdge> {
    state.create_collection_edge(collection_id, source_node_id, target_node_id, label)
}

#[tauri::command]
pub async fn update_collection_edge(
    state: State<'_, Workspace>,
    edge_id: String,
    label: String,
) -> Result<()> {
    state.update_collection_edge(&edge_id, &label)
}

#[tauri::command]
pub async fn delete_collection_edge(state: State<'_, Workspace>, edge_id: String) -> Result<()> {
    state.delete_collection_edge(&edge_id)
}

#[tauri::command]
pub async fn save_collection_viewport(
    state: State<'_, Workspace>,
    collection_id: String,
    viewport: Viewport,
) -> Result<()> {
    state.save_collection_viewport(&collection_id, viewport)
}

#[tauri::command]
pub async fn list_entry_collections(
    state: State<'_, Workspace>,
    entry_id: String,
) -> Result<Vec<Collection>> {
    state.list_entry_collections(&entry_id)
}

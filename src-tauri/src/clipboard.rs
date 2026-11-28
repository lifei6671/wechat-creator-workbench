use crate::{
    assets::{Assets, MAX_BYTES, remote_image_url, validate_dimensions},
    db::{AppError, Result, Workspace},
};
use arboard::{Clipboard, Error};
use image::{ExtendedColorType, ImageEncoder, codecs::png::PngEncoder};
use scraper::{Html, Selector};
use serde::Serialize;
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter, State};

const MAX_MARKDOWN_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Contents {
    Text {
        text: String,
    },
    Html {
        html: String,
        text: Option<String>,
    },
    Images {
        images: Vec<PastedImage>,
        errors: Vec<String>,
    },
}

#[derive(Serialize)]
pub struct PastedImage {
    id: String,
    name: String,
}

#[tauri::command]
pub async fn clipboard_write(db: State<'_, Workspace>, assets: State<'_, Assets>, text: String) -> Result<()> {
    let text=crate::assets::version_cleanup::protect_external(&db, &assets, &text).await?;
    Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(text))
        .map_err(clipboard_error)
}

#[tauri::command]
pub async fn clipboard_write_html(db: State<'_, Workspace>, assets: State<'_, Assets>, html: String, text: String) -> Result<()> {
    let html=crate::assets::version_cleanup::protect_external(&db, &assets, &html).await?;
    let text=crate::assets::version_cleanup::protect_external(&db, &assets, &text).await?;
    Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_html(html, Some(text)))
        .map_err(clipboard_error)
}

#[tauri::command]
pub async fn clipboard_read(
    app: AppHandle,
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    accept_images: bool,
    accept_html: bool,
) -> Result<Option<Contents>> {
    let mut clipboard = Clipboard::new().map_err(clipboard_error)?;
    let content = clipboard_content(&mut clipboard, &db, &assets, accept_images, accept_html)?;
    if matches!(&content, Some(Contents::Images { images, .. }) if !images.is_empty()) {
        let _ = app.emit("assets-changed", ());
    }
    Ok(content)
}

fn clipboard_content(
    clipboard: &mut Clipboard,
    db: &Workspace,
    assets: &Assets,
    accept_images: bool,
    accept_html: bool,
) -> Result<Option<Contents>> {
    if accept_images && let Some(paths) = optional(clipboard.get().file_list())? {
        return read_files(paths, db, assets).map(Some);
    }
    let rich = if accept_html {
        clipboard_rich(clipboard)?
    } else {
        None
    };
    if let Some(Contents::Html { html, .. }) = &rich
        && (!accept_images || prefer_rich_images(html))
    {
        return Ok(rich);
    }
    if accept_images && let Some(content) = read_bitmap(clipboard, db, assets)? {
        return Ok(Some(content));
    }
    if rich.is_some() {
        return Ok(rich);
    }
    optional(clipboard.get_text()).map(|text| text.map(|text| Contents::Text { text }))
}

fn prefer_rich_images(html: &str) -> bool {
    let fragment = Html::parse_fragment(html);
    let selector = Selector::parse("img[src], [data-workbench-src]").expect("valid image selector");
    // Browser bitmaps contain only one rendered frame. Keep the original image
    // source, including extensionless URLs, so GIF/WebP animation reaches import.
    fragment
        .select(&selector)
        .filter_map(|image| {
            let attrs = image.value();
            attrs
                .attr("src")
                .or_else(|| attrs.attr("data-workbench-src"))
        })
        .any(|src| {
            src.starts_with("asset://") || embedded_image(src) || remote_image_url(src).is_ok()
        })
}

fn embedded_image(src: &str) -> bool {
    src.split_once(',').is_some_and(|(header, data)| {
        !data.is_empty()
            && matches!(
                header.to_ascii_lowercase().as_str(),
                "data:image/png;base64"
                    | "data:image/jpeg;base64"
                    | "data:image/gif;base64"
                    | "data:image/webp;base64"
            )
    })
}

#[cfg(windows)]
fn clipboard_rich(_: &mut Clipboard) -> Result<Option<Contents>> {
    use clipboard_win::{formats, get, is_format_avail};

    let format = formats::Html::new()
        .ok_or_else(|| AppError::new("CLIPBOARD", "无法注册剪贴板 HTML 格式"))?;
    let read_error = |error| AppError::new("CLIPBOARD", format!("无法读取剪贴板：{error}"));
    let _open = clipboard_win::Clipboard::new_attempts(5).map_err(read_error)?;
    if !is_format_avail(format.code()) {
        return Ok(None);
    }
    let bytes: Vec<u8> = get(format).map_err(read_error)?;
    let html = String::from_utf8(bytes)
        .map_err(|error| AppError::new("CLIPBOARD", format!("剪贴板 HTML 编码无效：{error}")))?;
    let text = is_format_avail(formats::CF_UNICODETEXT)
        .then(|| get(formats::Unicode).map_err(read_error))
        .transpose()?;
    Ok(Some(Contents::Html { html, text }))
}

#[cfg(not(windows))]
fn clipboard_rich(clipboard: &mut Clipboard) -> Result<Option<Contents>> {
    let Some(html) = optional(clipboard.get().html())? else {
        return Ok(None);
    };
    let text = optional(clipboard.get_text())?;
    Ok(Some(Contents::Html { html, text }))
}

pub(crate) fn read_markdown_file(path: &Path) -> Result<String> {
    let mut bytes = Vec::new();
    let read_error = |error: std::io::Error| {
        AppError::new("CLIPBOARD", format!("无法读取 Markdown 文件：{error}"))
    };
    File::open(path)
        .and_then(|file| file.take(MAX_MARKDOWN_BYTES + 1).read_to_end(&mut bytes))
        .map_err(read_error)?;
    if bytes.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err(AppError::invalid("Markdown 文件不能超过 8 MB"));
    }
    let mut text = String::from_utf8(bytes)
        .map_err(|_| AppError::invalid("Markdown 文件须使用 UTF-8 编码"))?;
    if text.starts_with('\u{feff}') {
        text.drain(..'\u{feff}'.len_utf8());
    }
    Ok(text)
}

fn read_files(paths: Vec<PathBuf>, db: &Workspace, assets: &Assets) -> Result<Contents> {
    if let [path] = paths.as_slice()
        && let Some(extension) = path.extension().and_then(|value| value.to_str())
        && (extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown"))
    {
        return read_markdown_file(path).map(|text| Contents::Text { text });
    }
    let mut images = Vec::new();
    let mut errors = Vec::new();
    for path in paths {
        let name = path
            .file_name()
            .map_or_else(|| "图片".into(), |name| name.to_string_lossy().into_owned());
        let result = (|| {
            let mut bytes = Vec::new();
            File::open(&path)
                .and_then(|file| file.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes))
                .map_err(|error| AppError::new("ASSET_FILE", error.to_string()))?;
            assets.import(db, &name, &bytes)
        })();
        match result {
            Ok(id) => images.push(PastedImage { id, name }),
            Err(error) => errors.push(format!("{name}：{error}")),
        }
    }
    Ok(Contents::Images { images, errors })
}

fn read_bitmap(
    clipboard: &mut Clipboard,
    db: &Workspace,
    assets: &Assets,
) -> Result<Option<Contents>> {
    let Some(image) = optional(clipboard.get_image())? else {
        return Ok(None);
    };
    let width = u32::try_from(image.width).map_err(|_| AppError::invalid("剪贴板图片宽度无效"))?;
    let height =
        u32::try_from(image.height).map_err(|_| AppError::invalid("剪贴板图片高度无效"))?;
    validate_dimensions(width, height)?;
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(&image.bytes, width, height, ExtendedColorType::Rgba8)
        .map_err(|error| AppError::new("IMAGE_FORMAT", format!("无法编码剪贴板图片：{error}")))?;
    let name = "粘贴的图片.png".to_string();
    let id = assets.import(db, &name, &png)?;
    Ok(Some(Contents::Images {
        images: vec![PastedImage { id, name }],
        errors: vec![],
    }))
}

fn optional<T>(content: std::result::Result<T, Error>) -> Result<Option<T>> {
    match content {
        Ok(value) => Ok(Some(value)),
        Err(Error::ContentNotAvailable) => Ok(None),
        Err(error) => Err(clipboard_error(error)),
    }
}

fn clipboard_error(error: Error) -> AppError {
    AppError::new("CLIPBOARD", format!("无法访问系统剪贴板：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_markdown_as_text_without_the_utf8_bom() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("article.md");
        std::fs::write(&path, "\u{feff}# 标题\r\n\r\n- 第一项").unwrap();
        let text = read_markdown_file(&path).unwrap();
        assert_eq!(text, "# 标题\r\n\r\n- 第一项");
    }

    #[test]
    fn rich_clipboard_keeps_original_images_instead_of_browser_bitmaps() {
        let image = r#"<img src="https://images.example.org/work/cover.png" alt="封面">"#;
        let other = r#"<img src="https://images.example.org/other/cover.png">"#;
        assert!(prefer_rich_images(image));
        assert!(prefer_rich_images(other));
        assert!(prefer_rich_images(&format!("<p>正文</p>{other}")));
        assert!(prefer_rich_images(&format!("{other}{other}")));
        assert!(prefer_rich_images(
            r#"<p>正文<img src="data:image/png;base64,AAEC"></p>"#
        ));
        assert!(!prefer_rich_images(
            r#"<p>正文<img src="file:///C:/clip/image.png"></p>"#
        ));
        for url in [
            "https://raw.githubusercontent.com/kunkundi/crossdesk/mcp/docs/images/mcp-minesweeper.gif",
            "https://example.com/animation.webp?download=1",
            "https://example.com/image?id=animated",
        ] {
            assert!(
                prefer_rich_images(&format!(r#"<img src="{url}">"#)),
                "{url}"
            );
        }
        assert!(!prefer_rich_images("<p>只有正文</p>"));
    }
}

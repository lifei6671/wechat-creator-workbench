use super::image_header;
use crate::db::{AppError, Result};
use resvg::{tiny_skia, usvg, usvg::roxmltree};
use std::sync::{Arc, OnceLock};

const MAX_SVG_BYTES: usize = 512 * 1024;
const MAX_SVG_EDGE: u32 = 2048;
const MAX_SVG_PIXELS: u32 = 1024 * 1024;

pub(super) async fn normalize(bytes: Vec<u8>) -> Result<Vec<u8>> {
    let raster_error = match image_header(&bytes) {
        Ok(_) => return Ok(bytes),
        Err(error) if error.code() == "IMAGE_FORMAT" => error,
        Err(error) => return Err(error),
    };
    let Ok(text) = String::from_utf8(bytes) else {
        return Err(raster_error);
    };
    if !text
        .trim_start_matches('\u{feff}')
        .trim_start()
        .starts_with('<')
    {
        return Err(raster_error);
    }
    if text.len() > MAX_SVG_BYTES {
        return Err(AppError::new("IMAGE_SIZE", "外链 SVG 不能超过 512 KiB"));
    }
    tokio::task::spawn_blocking(move || rasterize_svg(&text, raster_error))
        .await
        .map_err(|error| AppError::new("IMAGE_FORMAT", format!("无法转换 SVG：{error}")))?
}

fn rasterize_svg(text: &str, raster_error: AppError) -> Result<Vec<u8>> {
    let document = roxmltree::Document::parse_with_options(
        text,
        roxmltree::ParsingOptions {
            nodes_limit: 4096,
            ..Default::default()
        },
    );
    let Ok(document) = document else {
        return Err(raster_error);
    };
    if !document
        .root_element()
        .has_tag_name(("http://www.w3.org/2000/svg", "svg"))
    {
        return Err(raster_error);
    }

    static FONTS: OnceLock<Arc<usvg::fontdb::Database>> = OnceLock::new();
    let fontdb = FONTS.get_or_init(|| {
        let mut fonts = usvg::fontdb::Database::new();
        fonts.load_system_fonts();
        Arc::new(fonts)
    });
    let options = usvg::Options {
        fontdb: Arc::clone(fontdb),
        max_depth: 32,
        // An SVG is a single image. Its content cannot read files or fetch another resource.
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: Box::new(|_, _, _| None),
            resolve_string: Box::new(|_, _| None),
        },
        ..Default::default()
    };
    let tree = usvg::Tree::from_xmltree(&document, &options)
        .map_err(|error| AppError::new("IMAGE_FORMAT", format!("无法读取 SVG：{error}")))?;
    let size = tree.size().to_int_size();
    let (width, height) = (size.width(), size.height());
    if width > MAX_SVG_EDGE || height > MAX_SVG_EDGE || width * height > MAX_SVG_PIXELS {
        return Err(AppError::new("IMAGE_SIZE", "外链 SVG 尺寸超出限制"));
    }
    let mut pixels = tiny_skia::Pixmap::new(width, height)
        .ok_or_else(|| AppError::new("IMAGE_SIZE", "无法分配 SVG 渲染空间"))?;
    resvg::render(
        &tree,
        tiny_skia::Transform::identity(),
        &mut pixels.as_mut(),
    );
    pixels.encode_png().map_err(|error| {
        AppError::new("IMAGE_FORMAT", format!("无法生成 SVG 的 PNG 图片：{error}"))
    })
}

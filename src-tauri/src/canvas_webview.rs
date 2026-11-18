use crate::{
    canvas_preview_cache::PreviewKey,
    db::{AppError, Result},
};
use serde::{Deserialize, Serialize};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};
use tauri::{
    Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Rect, WebviewUrl, Window,
    ipc::Response,
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
};
use url::Url;

const LABEL: &str = "canvas-web-preview";

#[derive(Default)]
pub(crate) struct PreviewState {
    scale: Arc<Mutex<f64>>,
    session: AtomicU64,
}

fn http_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && url.has_host()
}

pub(crate) fn parse_web_url(text: &str) -> Result<Url> {
    let invalid = || AppError::invalid("请输入有效的 HTTP 或 HTTPS 网页地址");
    let Some((_, address)) = text.split_once("://") else {
        return Err(invalid());
    };
    if address.starts_with(['/', '\\']) || text.chars().any(char::is_whitespace) {
        return Err(invalid());
    }
    Url::parse(text).ok().filter(http_url).ok_or_else(invalid)
}

#[derive(Deserialize)]
pub(crate) struct PreviewBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Deserialize)]
pub(crate) struct PreviewGeometry {
    #[serde(flatten)]
    bounds: PreviewBounds,
    clip: PreviewBounds,
    #[serde(rename = "layoutWidth")]
    layout_width: f64,
}

impl PreviewBounds {
    fn rect(self) -> Result<Rect> {
        if ![self.x, self.y, self.width, self.height]
            .into_iter()
            .all(f64::is_finite)
            || self.width <= 0.0
            || self.height <= 0.0
        {
            return Err(AppError::invalid("网页预览尺寸无效"));
        }
        Ok(Rect {
            position: LogicalPosition::new(self.x, self.y).into(),
            size: LogicalSize::new(self.width, self.height).into(),
        })
    }
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub(crate) enum Preview {
    Open {
        url: String,
        session: u64,
        bounds: PreviewGeometry,
        zoom: f64,
    },
    Bounds {
        bounds: Option<PreviewGeometry>,
        zoom: f64,
        resume: bool,
        #[serde(default, rename = "restoreScroll")]
        restore_scroll: bool,
    },
    Cover {
        #[serde(default, rename = "rememberScroll")]
        remember_scroll: bool,
    },
    Reveal,
    Close,
}

#[derive(Clone, Serialize)]
struct PreviewTitle {
    session: u64,
    title: String,
}

#[derive(Clone, Serialize)]
struct PreviewEvent {
    session: u64,
    event: &'static str,
}

fn emit_preview_event(webview: &tauri::Webview, session: u64, event: &'static str) {
    if let Err(error) = webview.emit_to(
        EventTarget::webview("main"),
        "canvas-web-state",
        PreviewEvent { session, event },
    ) {
        eprintln!("Could not report canvas web state: {error}");
    }
}

#[tauri::command]
pub(crate) async fn canvas_webview(
    window: Window,
    preview: Preview,
    state: tauri::State<'_, PreviewState>,
) -> Result<bool> {
    let child = window.get_webview(LABEL);
    let operation = match preview {
        Preview::Open {
            url,
            session,
            bounds,
            zoom,
        } => {
            validate_zoom(zoom)?;
            let url = parse_web_url(&url)?;
            let rect = bounds.bounds.rect()?;
            let clip = bounds.clip.rect()?;
            let layout_width = bounds.layout_width;
            #[cfg(windows)]
            let initial_rect = Rect {
                position: LogicalPosition::new(-10000, -10000).into(),
                size: rect.size,
            };
            #[cfg(not(windows))]
            let initial_rect = clipped_rect(rect, clip);
            if let Some(child) = child {
                child.close().map_err(preview_error)?;
            }
            state.session.store(0, Ordering::Release);
            let child = window
                .add_child(
                    WebviewBuilder::new(LABEL, WebviewUrl::External(url))
                        .incognito(true)
                        .focused(false)
                        .on_navigation(http_url)
                        .on_page_load(move |webview, payload| {
                            let event = match payload.event() {
                                PageLoadEvent::Started => "loading",
                                PageLoadEvent::Finished => "loaded",
                            };
                            emit_preview_event(&webview, session, event);
                        })
                        .on_document_title_changed(move |webview, title| {
                            if let Err(error) = webview.emit_to(
                                EventTarget::webview("main"),
                                "canvas-web-title",
                                PreviewTitle { session, title },
                            ) {
                                eprintln!("Could not report canvas web title: {error}");
                            }
                        })
                        .on_new_window(|_, _| NewWindowResponse::Deny)
                        .on_download(|_, _| false),
                    initial_rect.position,
                    initial_rect.size,
                )
                .map_err(preview_error)?;
            *state
                .scale
                .lock()
                .expect("canvas preview scale lock poisoned") = 0.0;
            let result = async {
                #[cfg(windows)]
                {
                    watch_escape(&child, session)?;
                    stack_view(child.clone(), true).await?;
                }
                update_view(
                    child.clone(),
                    rect,
                    clip,
                    layout_width,
                    zoom,
                    !cfg!(windows),
                    state.scale.clone(),
                )
                .await
            }
            .await;
            if result.is_err() {
                child.close().map_err(preview_error)?;
            } else {
                state.session.store(session, Ordering::Release);
            }
            return result.map(|()| cfg!(windows));
        }
        Preview::Bounds {
            bounds,
            zoom,
            resume,
            restore_scroll,
        } => {
            validate_zoom(zoom)?;
            if let Some(child) = child {
                if let Some(bounds) = bounds {
                    update_view(
                        child.clone(),
                        bounds.bounds.rect()?,
                        bounds.clip.rect()?,
                        bounds.layout_width,
                        zoom,
                        resume,
                        state.scale.clone(),
                    )
                    .await?;
                    if restore_scroll {
                        child.eval("(()=>{const p=window[Symbol.for('workbench.canvas.viewport')];if(p){scrollTo({left:p.x,top:p.y,behavior:'instant'});}})()").map_err(preview_error)?;
                    }
                    return Ok(false);
                }
                child.hide()
            } else {
                Ok(())
            }
        }
        Preview::Cover { remember_scroll } => {
            if let Some(child) = child {
                if remember_scroll {
                    remember_position(&child)?;
                }
                stack_view(child, true).await?;
                if let Some(main) = window.get_webview("main") {
                    main.set_focus().map_err(preview_error)?;
                }
            }
            return Ok(false);
        }
        Preview::Reveal => {
            if let Some(child) = child {
                stack_view(child, false).await?;
            }
            return Ok(false);
        }
        Preview::Close => {
            let closed = child.map_or(Ok(()), |child| child.close());
            if closed.is_ok() {
                state.session.store(0, Ordering::Release);
            }
            closed
        }
    };
    operation.map(|()| false).map_err(preview_error)
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct PreviewPage {
    url: String,
    x: f64,
    y: f64,
}

#[tauri::command]
pub(crate) async fn canvas_webview_page(
    window: Window,
    state: tauri::State<'_, PreviewState>,
    session: u64,
    restore: Option<PreviewPage>,
) -> Result<Option<PreviewPage>> {
    if session == 0 || state.session.load(Ordering::Acquire) != session {
        return Ok(None);
    }
    let Some(child) = window.get_webview(LABEL) else {
        return Ok(None);
    };
    let position = if let Some(page) = restore {
        parse_web_url(&page.url)?;
        let url = serde_json::to_string(&page.url)
            .map_err(|error| AppError::invalid(error.to_string()))?;
        format!(
            "if(location.href==={url})scrollTo({{left:{},top:{},behavior:'instant'}});",
            page.x, page.y
        )
    } else {
        String::new()
    };
    let (send, mut receive) = tokio::sync::mpsc::channel(1);
    child
        .eval_with_callback(
            format!("(()=>{{{position}return {{url:location.href,x:scrollX,y:scrollY}};}})()"),
            move |json| {
                let _ = send.try_send(json);
            },
        )
        .map_err(preview_error)?;
    let json = tokio::time::timeout(std::time::Duration::from_millis(750), receive.recv())
        .await
        .map_err(|_| AppError::new("WEB_PREVIEW", "读取网页位置超时"))?;
    if state.session.load(Ordering::Acquire) != session {
        return Ok(None);
    }
    Ok(json
        .and_then(|json| serde_json::from_str::<PreviewPage>(&json).ok())
        .filter(|page| parse_web_url(&page.url).is_ok()))
}

#[cfg(windows)]
fn watch_escape(child: &tauri::Webview, session: u64) -> Result<()> {
    use webview2_com::{
        AcceleratorKeyPressedEventHandler,
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
        },
    };
    let child_handle = child.clone();
    child
        .with_webview(move |view| {
            let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    // SAFETY: WebView2 supplies these arguments on its UI thread for this callback.
                    unsafe {
                        let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
                        let mut key = 0;
                        args.KeyEventKind(&mut kind)?;
                        args.VirtualKey(&mut key)?;
                        if kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && key == 0x1b {
                            args.SetHandled(true)?;
                            emit_preview_event(&child_handle, session, "escape");
                        }
                    }
                }
                Ok(())
            }));
            // SAFETY: The controller is used on its own UI thread and retains the handler.
            if let Err(error) = unsafe {
                view.controller()
                    .add_AcceleratorKeyPressed(&handler, &mut 0)
            } {
                eprintln!("Could not watch Escape in canvas web preview: {error}");
            }
        })
        .map_err(preview_error)
}

#[cfg(windows)]
async fn stack_view(child: tauri::Webview, covered: bool) -> Result<()> {
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{
            HWND_BOTTOM, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOREDRAW, SWP_NOSIZE,
            SetWindowPos,
        },
    };
    let (send, receive) = tokio::sync::oneshot::channel();
    child
        .with_webview(move |view| {
            // Keep WebView2 rendering behind the main view; hiding it suspends its paint surface.
            let result = unsafe {
                (|| -> windows::core::Result<()> {
                    let mut hwnd = HWND::default();
                    view.controller().ParentWindow(&mut hwnd)?;
                    SetWindowPos(
                        hwnd,
                        Some(if covered { HWND_BOTTOM } else { HWND_TOP }),
                        0,
                        0,
                        0,
                        0,
                        SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOREDRAW,
                    )
                })()
            };
            let _ = send.send(result.map_err(|error| {
                AppError::new("WEB_PREVIEW", format!("无法覆盖网页预览：{error}"))
            }));
        })
        .map_err(preview_error)?;
    receive
        .await
        .map_err(|error| AppError::new("WEB_PREVIEW", format!("网页预览覆盖中断：{error}")))?
}

#[cfg(not(windows))]
async fn stack_view(child: tauri::Webview, covered: bool) -> Result<()> {
    if covered { child.hide() } else { child.show() }.map_err(preview_error)
}

#[cfg(windows)]
async fn update_view(
    child: tauri::Webview,
    rect: Rect,
    clip: Rect,
    layout_width: f64,
    _zoom: f64,
    resume: bool,
    baseline: std::sync::Arc<std::sync::Mutex<f64>>,
) -> Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller3;
    use windows::Win32::{
        Foundation::{HWND, RECT},
        Graphics::Gdi::{CreateRectRgn, DeleteObject, SetWindowRgn},
        UI::WindowsAndMessaging::{HWND_TOP, SWP_NOACTIVATE, SWP_NOZORDER, SetWindowPos},
    };
    use windows::core::Interface;
    let scale = child.window().scale_factor().map_err(preview_error)?;
    let position = rect.position.to_physical::<i32>(scale);
    let size = rect.size.to_physical::<i32>(scale);
    if !layout_width.is_finite() || layout_width <= 0.0 {
        return Err(AppError::invalid("网页排版宽度无效"));
    }
    let crop_start = clip.position.to_physical::<i32>(scale);
    let crop_size = clip.size.to_physical::<i32>(scale);
    let (send, receive) = tokio::sync::oneshot::channel();
    child
        .with_webview(move |webview| {
            let controller = webview.controller();
            // Both values must change together so the page keeps its CSS viewport while scaling.
            // The controller and its parent HWND belong to the live child on this UI thread.
            let result = unsafe {
                (|| -> windows::core::Result<()> {
                    let mut hwnd = HWND::default();
                    controller.ParentWindow(&mut hwnd)?;
                    // WebView2 clamps page zoom at 25%. Raster scaling covers the rest of the canvas range.
                    // Keep subpixel rounding from adding an extra CSS pixel to the page viewport.
                    let effective_zoom = size.width as f64 / (layout_width * scale) * (1.0 + 1e-7);
                    let page_zoom = effective_zoom.max(0.25);
                    let raster = controller.cast::<ICoreWebView2Controller3>()?;
                    let mut factor = baseline.lock().unwrap();
                    if *factor == 0.0 {
                        let mut original = 0.0;
                        raster.RasterizationScale(&mut original)?;
                        *factor = original / scale;
                    }
                    let desired_raster = scale * *factor * effective_zoom / page_zoom;
                    let mut current_raster = 0.0;
                    raster.RasterizationScale(&mut current_raster)?;
                    if (current_raster - desired_raster).abs() > 0.000001 {
                        raster.SetShouldDetectMonitorScaleChanges(false)?;
                        raster.SetRasterizationScale(desired_raster)?;
                    }
                    raster.SetShouldDetectMonitorScaleChanges(effective_zoom >= 0.25)?;
                    let region = CreateRectRgn(
                        crop_start.x,
                        crop_start.y,
                        crop_start.x + crop_size.width,
                        crop_start.y + crop_size.height,
                    );
                    if region.is_invalid() {
                        return Err(windows::core::Error::from_thread());
                    }
                    if SetWindowRgn(hwnd, Some(region), true) == 0 {
                        let error = windows::core::Error::from_thread();
                        let _ = DeleteObject(region.into());
                        return Err(error);
                    }
                    controller.SetBoundsAndZoomFactor(
                        RECT {
                            left: 0,
                            top: 0,
                            right: size.width,
                            bottom: size.height,
                        },
                        page_zoom,
                    )?;
                    SetWindowPos(
                        hwnd,
                        resume.then_some(HWND_TOP),
                        position.x,
                        position.y,
                        size.width,
                        size.height,
                        SWP_NOACTIVATE
                            | if resume {
                                Default::default()
                            } else {
                                SWP_NOZORDER
                            },
                    )?;
                    Ok(())
                })()
            };
            let _ = send.send(result.map_err(|error| {
                AppError::new("WEB_PREVIEW", format!("无法缩放网页预览：{error}"))
            }));
        })
        .map_err(preview_error)?;
    receive
        .await
        .map_err(|error| AppError::new("WEB_PREVIEW", format!("网页预览更新中断：{error}")))??;
    if resume {
        child.show().map_err(preview_error)?;
    }
    Ok(())
}

#[cfg(not(windows))]
async fn update_view(
    child: tauri::Webview,
    rect: Rect,
    clip: Rect,
    _layout_width: f64,
    zoom: f64,
    resume: bool,
    _baseline: std::sync::Arc<std::sync::Mutex<f64>>,
) -> Result<()> {
    child.set_zoom(zoom).map_err(preview_error)?;
    child
        .set_bounds(clipped_rect(rect, clip))
        .map_err(preview_error)?;
    if resume {
        child.show().map_err(preview_error)?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn clipped_rect(rect: Rect, clip: Rect) -> Rect {
    let origin = rect.position.to_logical::<f64>(1.0);
    let offset = clip.position.to_logical::<f64>(1.0);
    Rect {
        position: LogicalPosition::new(origin.x + offset.x, origin.y + offset.y).into(),
        size: clip.size,
    }
}

fn validate_zoom(zoom: f64) -> Result<()> {
    if !zoom.is_finite() || !(0.1..=3.0).contains(&zoom) {
        return Err(AppError::invalid("网页预览缩放比例无效"));
    }
    Ok(())
}

fn preview_error(error: tauri::Error) -> AppError {
    AppError::new("WEB_PREVIEW", format!("网页预览不可用：{error}"))
}

fn remember_position(child: &tauri::Webview) -> Result<()> {
    child
        .eval("window[Symbol.for('workbench.canvas.viewport')]={x:scrollX,y:scrollY};")
        .map_err(preview_error)
}

#[tauri::command]
pub(crate) async fn canvas_webview_snapshot(
    window: Window,
    remember_scroll: Option<bool>,
    cache: Option<PreviewKey>,
) -> Result<Response> {
    #[cfg(not(windows))]
    {
        let _ = (window, remember_scroll, cache);
        Ok(Response::new(Vec::<u8>::new()))
    }
    #[cfg(windows)]
    {
        use std::{cell::RefCell, rc::Rc};
        use webview2_com::{
            CapturePreviewCompletedHandler,
            Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
        };
        use windows::Win32::{
            System::Com::{STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET},
            UI::Shell::SHCreateMemStream,
        };
        let Some(child) = window.get_webview(LABEL) else {
            return Ok(Response::new(Vec::<u8>::new()));
        };
        if remember_scroll.unwrap_or(true) {
            remember_position(&child)?;
        }
        let (send, receive) = tokio::sync::oneshot::channel();
        child
            .with_webview(move |view| {
                let sender = Rc::new(RefCell::new(Some(send)));
                let complete = sender.clone();
                // SAFETY: The controller and stream are used on the WebView2 UI thread.
                let start = unsafe {
                    (|| -> windows::core::Result<()> {
                        let stream = SHCreateMemStream(None)
                            .ok_or_else(windows::core::Error::from_thread)?;
                        let captured = stream.clone();
                        let handler =
                            CapturePreviewCompletedHandler::create(Box::new(move |status| {
                                let result = (|| -> windows::core::Result<Vec<u8>> {
                                    status?;
                                    let mut stat = STATSTG::default();
                                    captured.Stat(&mut stat, STATFLAG_NONAME)?;
                                    captured.Seek(0, STREAM_SEEK_SET, None)?;
                                    let length = u32::try_from(stat.cbSize)
                                        .map_err(|_| windows::core::Error::from_thread())?;
                                    let mut bytes = vec![0; length as usize];
                                    let mut read = 0;
                                    captured
                                        .Read(bytes.as_mut_ptr().cast(), length, Some(&mut read))
                                        .ok()?;
                                    bytes.truncate(read as usize);
                                    Ok(bytes)
                                })();
                                if let Some(send) = complete.borrow_mut().take() {
                                    let _ = send.send(result.map_err(|error| {
                                        AppError::new(
                                            "WEB_PREVIEW",
                                            format!("无法生成网页缩放画面：{error}"),
                                        )
                                    }));
                                }
                                Ok(())
                            }));
                        view.controller().CoreWebView2()?.CapturePreview(
                            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                            &stream,
                            &handler,
                        )
                    })()
                };
                if let Err(error) = start
                    && let Some(send) = sender.borrow_mut().take()
                {
                    let _ = send.send(Err(AppError::new(
                        "WEB_PREVIEW",
                        format!("无法生成网页缩放画面：{error}"),
                    )));
                }
            })
            .map_err(preview_error)?;
        let png = tokio::time::timeout(std::time::Duration::from_millis(750), receive)
            .await
            .map_err(|_| AppError::new("WEB_PREVIEW", "生成网页缩放画面超时"))?
            .map_err(|error| {
                AppError::new("WEB_PREVIEW", format!("网页缩放画面已取消：{error}"))
            })??;
        let app = window.app_handle().clone();
        tauri::async_runtime::spawn_blocking(move || {
            if !contains_page_pixels(&png) {
                return Response::new(Vec::<u8>::new());
            }
            if let Some(key) = cache
                && let Err(error) = crate::canvas_preview_cache::save(&app, &key, &png)
            {
                eprintln!("Could not save canvas preview cache: {error}");
            }
            Response::new(png)
        })
        .await
        .map_err(preview_error)
    }
}

#[cfg(any(windows, test))]
fn contains_page_pixels(png: &[u8]) -> bool {
    use image::GenericImageView;

    let Ok(image) = image::load_from_memory_with_format(png, image::ImageFormat::Png) else {
        return false;
    };
    let image = image.into_rgba8();
    let (width, height) = image.dimensions();
    // A loading page can paint its background and native scrollbars before its content.
    let content = image.view(0, 0, width - width / 8, height - height / 8);
    let mut pixels = content
        .pixels()
        .filter_map(|(_, _, pixel)| (pixel[3] > 0).then_some(pixel));
    let Some(background) = pixels.next() else {
        return false;
    };
    pixels.any(|pixel| (0..3).any(|channel| pixel[channel].abs_diff(background[channel]) > 5))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_initial_frames_without_discarding_page_content() {
        use image::{ImageEncoder, Rgba, RgbaImage, codecs::png::PngEncoder};
        let png = |image: &RgbaImage| {
            let mut output = Vec::new();
            PngEncoder::new(&mut output)
                .write_image(
                    image,
                    image.width(),
                    image.height(),
                    image::ExtendedColorType::Rgba8,
                )
                .unwrap();
            output
        };
        let blank = RgbaImage::new(80, 48);
        assert!(!contains_page_pixels(&png(&blank)));
        let mut loading = RgbaImage::from_pixel(80, 48, Rgba([178, 149, 36, 255]));
        for y in 0..loading.height() {
            loading.put_pixel(77, y, Rgba([240, 240, 240, 255]));
        }
        assert!(!contains_page_pixels(&png(&loading)));
        loading.put_pixel(2, 3, Rgba([72, 67, 60, 255]));
        assert!(contains_page_pixels(&png(&loading)));
        assert!(!contains_page_pixels(b"invalid png"));
    }

    #[test]
    fn accepts_only_complete_http_urls() {
        assert!(parse_web_url("HTTPS://example.test/path?q=1#section").is_ok());
        assert!(parse_web_url("http://localhost:8080").is_ok());
        for invalid in [
            "file:///notes",
            "https:example.test",
            "https:///example.test",
            "https://",
            "https://one.test https://two.test",
        ] {
            assert!(parse_web_url(invalid).is_err(), "accepted {invalid}");
        }
    }
}

use super::{emit_preview_event, preview_error};
use crate::db::{AppError, Result};
use block2::RcBlock;
use objc2::{MainThreadMarker, rc::Retained, runtime::AnyObject};
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSEvent, NSEventMask, NSImage, NSView,
    NSWindowOrderingMode,
};
use objc2_foundation::{NSDictionary, NSError, NSPoint, NSRect, NSSize};
use objc2_web_kit::WKWebView;
use std::{
    cell::RefCell,
    ptr::NonNull,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Rect, Webview};
use tokio::sync::oneshot;

struct Surface {
    clip: Retained<NSView>,
    escape_monitor: Retained<AnyObject>,
}

// The single canvas child and its AppKit objects are managed on the UI thread.
thread_local! {
    static SURFACE: RefCell<Option<Surface>> = const { RefCell::new(None) };
}

fn error(message: impl Into<String>) -> AppError {
    AppError::new("WEB_PREVIEW", message)
}

async fn on_view<T: Send + 'static>(
    child: &Webview,
    operation: impl FnOnce(&WKWebView) -> Result<T> + Send + 'static,
) -> Result<T> {
    let (send, receive) = oneshot::channel();
    child
        .with_webview(move |view| {
            // Tauri supplies a live WKWebView on the main thread.
            let webview = unsafe { &*view.inner().cast::<WKWebView>() };
            let _ = send.send(operation(webview));
        })
        .map_err(preview_error)?;
    receive.await.map_err(|_| error("网页预览窗口已关闭"))?
}

pub(super) async fn attach(child: &Webview, session: u64) -> Result<()> {
    let child_handle = child.clone();
    on_view(child, move |webview| {
        let mtm = MainThreadMarker::from(webview);
        let parent = unsafe { webview.superview() }.expect("canvas webview is attached");
        let clip = NSView::initWithFrame(mtm.alloc(), webview.frame());
        clip.setClipsToBounds(true);
        let monitor_clip = clip.clone();
        let handler = RcBlock::new(move |event: NonNull<NSEvent>| {
            let key = unsafe { event.as_ref() };
            if key.keyCode() == 53
                && let Some(window) = key.window(mtm)
                && let Some(responder) = window.firstResponder()
                && let Some(view) = responder.downcast_ref::<NSView>()
                && view.isDescendantOf(&monitor_clip)
            {
                emit_preview_event(&child_handle, session, "escape");
                return std::ptr::null_mut();
            }
            event.as_ptr()
        });
        // The handler returns the incoming event or null to consume Escape.
        let escape_monitor = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &handler)
        }
        .ok_or_else(|| error("无法监听网页预览快捷键"))?;
        parent.addSubview_positioned_relativeTo(&clip, NSWindowOrderingMode::Below, None);
        clip.addSubview(webview);
        SURFACE.with_borrow_mut(|surface| {
            *surface = Some(Surface {
                clip,
                escape_monitor,
            })
        });
        Ok(())
    })
    .await
}

pub(super) async fn detach(child: &Webview) -> Result<()> {
    on_view(child, |_| {
        if let Some(surface) = SURFACE.take() {
            unsafe { NSEvent::removeMonitor(&surface.escape_monitor) };
            surface.clip.removeFromSuperview();
        }
        Ok(())
    })
    .await
}

pub(super) async fn stack_view(child: Webview, covered: bool) -> Result<()> {
    on_view(&child, move |_| {
        SURFACE.with_borrow(|surface| {
            let clip = &surface
                .as_ref()
                .expect("canvas preview surface is attached")
                .clip;
            let parent = unsafe { clip.superview() }.expect("canvas preview has a parent");
            // Keep WebKit attached and rendering while the main webview displays the snapshot.
            let order = if covered {
                NSWindowOrderingMode::Below
            } else {
                NSWindowOrderingMode::Above
            };
            parent.addSubview_positioned_relativeTo(clip, order, None);
        });
        Ok(())
    })
    .await
}

pub(super) async fn update_view(
    child: Webview,
    rect: Rect,
    clip: Rect,
    layout_width: f64,
    _zoom: f64,
    resume: bool,
    _baseline: Arc<Mutex<f64>>,
) -> Result<()> {
    if !layout_width.is_finite() || layout_width <= 0.0 {
        return Err(AppError::invalid("网页排版宽度无效"));
    }
    let origin = rect.position.to_logical::<f64>(1.0);
    let size = rect.size.to_logical::<f64>(1.0);
    let offset = clip.position.to_logical::<f64>(1.0);
    let visible = clip.size.to_logical::<f64>(1.0);
    on_view(&child, move |webview| {
        SURFACE.with_borrow(|surface| {
            let clip = &surface
                .as_ref()
                .expect("canvas preview surface is attached")
                .clip;
            let parent = unsafe { clip.superview() }.expect("canvas preview has a parent");
            let window = parent.window().expect("canvas preview is in a window");
            let content_view = window.contentView().expect("workspace window has content");
            let content = parent.convertRect_fromView(content_view.bounds(), Some(&content_view));
            let top = origin.y + offset.y;
            let y = if parent.isFlipped() {
                content.origin.y + top
            } else {
                content.origin.y + content.size.height - top - visible.height
            };
            clip.setFrame(NSRect::new(
                NSPoint::new(content.origin.x + origin.x + offset.x, y),
                NSSize::new(visible.width, visible.height),
            ));
            // Clip the surface without resizing the webpage's CSS viewport.
            webview.setFrame(NSRect::new(
                NSPoint::new(-offset.x, offset.y + visible.height - size.height),
                NSSize::new(size.width, size.height),
            ));
            let zoom = size.width / layout_width;
            // pageZoom is available on every supported macOS release.
            unsafe {
                if (webview.pageZoom() - zoom).abs() > 1e-6 {
                    webview.setPageZoom(zoom);
                }
            }
        });
        Ok(())
    })
    .await?;
    if resume {
        stack_view(child, false).await?;
    }
    Ok(())
}

pub(super) async fn capture(child: &Webview) -> Result<Vec<u8>> {
    let (send, receive) = oneshot::channel();
    on_view(child, move |webview| {
        let mtm = MainThreadMarker::from(webview);
        let send = RefCell::new(Some(send));
        let callback = RcBlock::new(move |image: *mut NSImage, failure: *mut NSError| {
            // WebKit supplies these objects for the duration of the callback.
            let result = match unsafe { image.as_ref() } {
                Some(image) => image
                    .TIFFRepresentation()
                    .and_then(|data| NSBitmapImageRep::initWithData(mtm.alloc(), &data))
                    .and_then(|bitmap| unsafe {
                        bitmap.representationUsingType_properties(
                            NSBitmapImageFileType::PNG,
                            &NSDictionary::new(),
                        )
                    })
                    .map(|data| data.to_vec())
                    .ok_or_else(|| error("无法编码网页预览图片")),
                None => Err(error(format!(
                    "无法生成网页缩放画面：{}",
                    unsafe { failure.as_ref() }.map_or_else(
                        || "WebKit 未返回图片".into(),
                        |error| error.localizedDescription().to_string()
                    )
                ))),
            };
            let _ = send
                .take()
                .expect("WKWebView completes each snapshot once")
                .send(result);
        });
        // WebKit copies the completion block when it starts the snapshot.
        unsafe { webview.takeSnapshotWithConfiguration_completionHandler(None, &callback) };
        Ok(())
    })
    .await?;
    tokio::time::timeout(Duration::from_millis(750), receive)
        .await
        .map_err(|_| error("生成网页缩放画面超时"))?
        .map_err(|_| error("网页缩放画面已取消"))?
}

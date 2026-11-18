use block2::RcBlock;
use objc2::{
    rc::Retained,
    runtime::{NSObjectProtocol, ProtocolObject},
};
use objc2_app_kit::{
    NSButton, NSWindow, NSWindowButton, NSWindowDidUpdateNotification, NSWindowStyleMask,
    NSWindowWillCloseNotification,
};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSOperationQueue, NSPoint};
use std::{cell::RefCell, ptr::NonNull};
use tauri::Manager;

// Half of --chrome-height in the desktop title bar.
const TITLEBAR_CENTER: f64 = 20.0;

thread_local! {
    static OBSERVERS: RefCell<Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>> =
        const { RefCell::new(Vec::new()) };
}

pub(crate) fn align_main_titlebar(app: &tauri::App) -> tauri::Result<()> {
    let main = app
        .get_webview_window("main")
        .expect("main workspace window");
    // Tauri runs setup on the AppKit thread, and the main window owns this handle.
    let window = unsafe { &*main.ns_window()?.cast::<NSWindow>() };
    let center = NSNotificationCenter::defaultCenter();
    let queue = NSOperationQueue::mainQueue();
    let align = RcBlock::new(|notification: NonNull<NSNotification>| {
        // AppKit passes a live notification for the duration of the callback.
        if let Some(object) = unsafe { notification.as_ref() }.object()
            && let Some(window) = object.downcast_ref::<NSWindow>()
        {
            align_buttons(window);
        }
    });
    // AppKit can recreate or reposition the standard buttons during window updates.
    let alignment = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSWindowDidUpdateNotification),
            Some(window),
            Some(&queue),
            &align,
        )
    };
    let close = RcBlock::new(|_: NonNull<NSNotification>| {
        let center = NSNotificationCenter::defaultCenter();
        for observer in OBSERVERS.take() {
            unsafe { center.removeObserver((*observer).as_ref()) };
        }
    });
    let cleanup = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSWindowWillCloseNotification),
            Some(window),
            Some(&queue),
            &close,
        )
    };
    OBSERVERS.set(vec![alignment, cleanup]);
    align_buttons(window);
    Ok(())
}

fn buttons(window: &NSWindow) -> impl Iterator<Item = Retained<NSButton>> + '_ {
    [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .into_iter()
    .filter_map(|kind| window.standardWindowButton(kind))
}

fn align_buttons(window: &NSWindow) {
    if window.styleMask().contains(NSWindowStyleMask::FullScreen) {
        return;
    }
    let Some(content) = window.contentView() else {
        return;
    };
    let bounds = content.bounds();
    let center = if content.isFlipped() {
        bounds.origin.y + TITLEBAR_CENTER
    } else {
        bounds.origin.y + bounds.size.height - TITLEBAR_CENTER
    };
    for button in buttons(window) {
        if let Some(parent) = unsafe { button.superview() } {
            let center = parent.convertPoint_fromView(NSPoint::new(0.0, center), Some(&content));
            let frame = button.frame();
            let y = center.y - frame.size.height / 2.0;
            if (frame.origin.y - y).abs() >= 0.25 {
                button.setFrameOrigin(NSPoint::new(frame.origin.x, y));
            }
        }
    }
}

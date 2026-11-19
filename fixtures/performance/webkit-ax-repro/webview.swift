import AppKit
import WebKit

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 30, y: 30, width: 1360, height: 840),
                      styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
let web = WKWebView(frame: .zero)
window.contentView = web
window.title = "WebKit Accessibility Test"
window.makeKeyAndOrderFront(nil)
let url = URL(fileURLWithPath: CommandLine.arguments[1])
web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
app.activate(ignoringOtherApps: true)
app.run()

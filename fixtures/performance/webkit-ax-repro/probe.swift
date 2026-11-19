import ApplicationServices
import Foundation

guard CommandLine.arguments.count == 2, let pid = pid_t(CommandLine.arguments[1]) else {
    print("Usage: swift probe.swift <workbench-pid>")
    exit(2)
}
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 2)
var marker: AXUIElement?

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return error == .success ? value : nil
}

func findEditor(_ element: AXUIElement) -> AXUIElement? {
    if let label = attribute(element, "AXValue") as? String, label.hasPrefix("AXTEST") {
        marker = element
    }
    if attribute(element, "AXDescription") as? String == "正文" { return element }
    let children = (attribute(element, "AXChildren") ?? attribute(element, "AXWindows")) as? [AXUIElement]
    return children?.lazy.compactMap(findEditor).first
}

guard AXIsProcessTrusted() else {
    print("Grant Accessibility access to the terminal running this local probe.")
    exit(2)
}

let deadline = Date().addingTimeInterval(20)
var last = ""
while Date() < deadline {
    if let editor = findEditor(app), let marker, let status = attribute(marker, "AXValue") as? String,
       status != last, status != "AXTEST ready" {
        last = status
        let start = Date()
        if attribute(editor, "AXVisibleCharacterRange") == nil {
            let elapsed = Int(Date().timeIntervalSince(start) * 1000)
            print("AXVisibleCharacterRange failed after \(elapsed) ms at \(status)")
            exit(1)
        }
        if status == "AXTEST done" {
            print("Completed without an AXVisibleCharacterRange timeout.")
            exit(0)
        }
    }
    Thread.sleep(forTimeInterval: 0.045)
}
print("The scroll fixture did not finish within the test window.")
exit(2)

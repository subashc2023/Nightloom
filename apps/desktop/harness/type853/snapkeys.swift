// snapkeys — item 853: load a page in WebKit (activation .prohibited, never ordered front, never takes focus), wait for
// window.__ready, then send REAL AppKit events to the WKWebView: a mouse click at window.__at ([x, y] CSS px) and the
// key "h"; then print window.__report().
//   snapkeys <file#hash> <css-w> <css-h> <timeout-s>
import AppKit
import WebKit
let a = CommandLine.arguments
let w = Double(a[2])!, h = Double(a[3])!, limit = Double(a[4])!
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
final class KeyWin: NSWindow { override var canBecomeKey: Bool { true } }
let frame = NSRect(x: 0, y: 0, width: w, height: h)
let win = KeyWin(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
let web = WKWebView(frame: frame)
win.contentView = web
func js(_ s: String, _ k: @escaping (Any?) -> Void) { web.evaluateJavaScript(s) { r, _ in k(r) } }
func mouse(_ t: NSEvent.EventType, _ p: NSPoint) -> NSEvent {
  NSEvent.mouseEvent(with: t, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: win.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: t == .leftMouseDown ? 1 : 0)!
}
func key(_ t: NSEvent.EventType) -> NSEvent {
  NSEvent.keyEvent(with: t, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: win.windowNumber, context: nil, characters: "h", charactersIgnoringModifiers: "h", isARepeat: false, keyCode: 4)!
}
func after(_ s: Double, _ f: @escaping () -> Void) { DispatchQueue.main.asyncAfter(deadline: .now() + s, execute: f) }
final class Nav: NSObject, WKNavigationDelegate {
  func webView(_ v: WKWebView, didFinish _: WKNavigation!) { poll() }
  func poll() {
    js("window.__ready ? JSON.stringify(window.__at) : null") { r in
      guard let s = r as? String, let d = s.data(using: .utf8), let at = try? JSONSerialization.jsonObject(with: d) as? [Double], at.count == 2 else { after(0.2) { self.poll() }; return }
      win.makeFirstResponder(web)
      let p = NSPoint(x: at[0], y: h - at[1])
      // __at x < 0: no click (a scroll case, item 853 / blocker 2204: the page scrolls in __afterClick).
      let click = at[0] >= 0
      if click { web.mouseDown(with: mouse(.leftMouseDown, p)) }
      after(0.08) {
        if click { web.mouseUp(with: mouse(.leftMouseUp, p)) }
        after(0.4) {
          js("window.__afterClick && window.__afterClick()") { _ in
            web.keyDown(with: key(.keyDown))
            after(0.08) {
              web.keyUp(with: key(.keyUp))
              after(0.6) { js("String(window.__report())") { r in print(r as? String ?? "no report"); exit(0) } }
            }
          }
        }
      }
    }
  }
  func webView(_: WKWebView, didFail _: WKNavigation!, withError e: Error) { print("load failed: \(e)"); exit(1) }
  func webView(_: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError e: Error) { print("load failed: \(e)"); exit(1) }
}
let nav = Nav()
web.navigationDelegate = nav
let parts = a[1].components(separatedBy: "#")
var target = URL(fileURLWithPath: parts[0])
if parts.count > 1 { target = URL(string: target.absoluteString + "#" + parts[1])! }
web.loadFileURL(target, allowingReadAccessTo: URL(fileURLWithPath: "/"))
after(limit) { print("timeout"); exit(1) }
app.run()

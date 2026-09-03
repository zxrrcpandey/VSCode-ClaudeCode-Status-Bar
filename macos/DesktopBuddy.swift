// Desktop buddy: the character roaming your actual screen, above every app.
//
// The animation, art and dialogue are the shared buddy.html — the same file
// the VS Code panel uses — hosted in a transparent, borderless, always-on-top
// panel. The screen edges become its floor, walls and ceiling, so it walks
// along the bottom of the display, climbs the sides and hangs from the top.
//
// Clicks pass straight through the window to whatever is underneath, except
// on the character itself: the page reports its position and only that small
// rectangle is hit-testable, so the buddy can never eat a click meant for
// another app.

import AppKit
import WebKit

final class DesktopBuddy: NSObject, WKScriptMessageHandler, WKNavigationDelegate {

    private var panel: NSPanel?
    private var webView: WKWebView?
    private var container: PassthroughView?
    private var lastPayload: String = "{}"
    private var ready = false

    static let characters = ["critter", "robot", "cat", "pup", "turtle", "snail", "bee", "dragon", "ghost"]

    var isVisible: Bool { panel?.isVisible ?? false }

    // MARK: Lifecycle

    func toggle() { isVisible ? hide() : show() }

    func show() {
        if panel == nil { build() }
        panel?.orderFrontRegardless()
        UserDefaults.standard.set(true, forKey: "buddyVisible")
    }

    func hide() {
        panel?.orderOut(nil)
        UserDefaults.standard.set(false, forKey: "buddyVisible")
    }

    /// Rebuild from scratch — used when the character changes.
    func reload() {
        let wasVisible = isVisible
        panel?.orderOut(nil)
        webView?.configuration.userContentController.removeAllUserScripts()
        webView = nil; container = nil; panel = nil; ready = false
        if wasVisible { show() }
    }

    /// One window spanning every display, so the character can walk from one
    /// screen to the next. visibleFrame keeps it out of the menu bar and off
    /// the Dock — it walks along the top of the Dock instead of under it.
    private static func spanFrame() -> NSRect {
        var f = NSRect.zero
        for s in NSScreen.screens { f = f.isEmpty ? s.visibleFrame : f.union(s.visibleFrame) }
        return f.isEmpty ? (NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)) : f
    }

    private func build() {
        let frame = Self.spanFrame()

        let cfg = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        // buddy.html is written for a VS Code webview; give it the same tiny API.
        ucc.addUserScript(WKUserScript(source: """
            window.acquireVsCodeApi = function () {
              return { postMessage: function (m) { window.webkit.messageHandlers.pulse.postMessage(m); },
                       getState: function () { return null; }, setState: function () {} };
            };
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // Report where the character is, so only that rectangle catches clicks.
        ucc.addUserScript(WKUserScript(source: """
            (function () {
              function report() {
                var el = document.getElementById('char');
                if (el) {
                  var r = el.getBoundingClientRect();
                  window.webkit.messageHandlers.pulse.postMessage(
                    { type: 'rect', x: r.left, y: r.top, w: r.width, h: r.height });
                }
                setTimeout(report, 100);
              }
              window.addEventListener('load', report);
            })();
            """, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        ucc.add(self, name: "pulse")
        cfg.userContentController = ucc

        let web = WKWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: cfg)
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")      // transparent over the desktop
        if #available(macOS 12.0, *) { web.underPageBackgroundColor = .clear }
        web.autoresizingMask = [.width, .height]
        web.loadHTMLString(html(), baseURL: nil)

        let view = PassthroughView(frame: NSRect(origin: .zero, size: frame.size))
        view.addSubview(web)

        // A non-activating panel never steals focus from the app you are using.
        let p = NSPanel(contentRect: frame,
                        styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.level = .floating                                   // above ordinary windows
        p.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        p.isFloatingPanel = true
        p.hidesOnDeactivate = false
        p.contentView = view
        p.setFrame(frame, display: true)

        panel = p; webView = web; container = view

        // Follow display changes (resolution, arrangement, a screen unplugged).
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self, let panel = self.panel else { return }
            let f = Self.spanFrame()
            panel.setFrame(f, display: true)
            self.webView?.frame = NSRect(origin: .zero, size: f.size)
            self.container?.frame = NSRect(origin: .zero, size: f.size)
        }
    }

    // MARK: Content

    private func html() -> String {
        guard let path = Bundle.main.path(forResource: "buddy", ofType: "html"),
              var raw = try? String(contentsOfFile: path, encoding: .utf8) else {
            return "<html><body></body></html>"
        }
        let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let character = UserDefaults.standard.string(forKey: "buddyCharacter") ?? "critter"
        // Custom images are inlined as data: URIs — no file access needed, and
        // it keeps the page's strict CSP intact.
        var img = ""
        if let p = UserDefaults.standard.string(forKey: "buddyImage"), !p.isEmpty,
           let data = FileManager.default.contents(atPath: p) {
            let ext = (p as NSString).pathExtension.lowercased()
            let mime = ["png": "image/png", "gif": "image/gif", "webp": "image/webp",
                        "svg": "image/svg+xml", "jpg": "image/jpeg", "jpeg": "image/jpeg"][ext] ?? "image/png"
            img = "data:\(mime);base64," + data.base64EncodedString()
        }
        raw = raw.replacingOccurrences(of: "{{nonce}}", with: nonce)
        raw = raw.replacingOccurrences(of: "{{csp}}", with: "data:")
        raw = raw.replacingOccurrences(of: "{{img}}", with: img)
        raw = raw.replacingOccurrences(of: "{{char}}", with: Self.characters.contains(character) ? character : "critter")
        raw = raw.replacingOccurrences(of: "{{name}}", with: Self.userName())
        // On the desktop there is no panel to draw a floor line or a hint in.
        // Zoom scales the character while leaving it the whole screen to roam.
        let zoom = UserDefaults.standard.object(forKey: "buddyZoom") as? Double ?? 1.0
        raw = raw.replacingOccurrences(of: "</head>", with: """
            <style>#floor,#hint{display:none!important}
            html,body{background:transparent!important}
            #char{zoom:\(zoom)}</style></head>
            """)
        return raw
    }

    static func userName() -> String {
        if let n = UserDefaults.standard.string(forKey: "buddyName"), !n.isEmpty { return sanitize(n) }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["config", "--get", "user.name"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        if (try? p.run()) != nil {
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            if let s = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
                return sanitize(s)
            }
        }
        return sanitize(NSFullUserName())
    }

    /// The name lands inside the page's HTML — keep it to plain characters.
    private static func sanitize(_ s: String) -> String {
        let first = s.split(separator: " ").first.map(String.init) ?? s
        return String(first.unicodeScalars.filter {
            CharacterSet.alphanumerics.contains($0) || $0 == "." || $0 == "'" || $0 == "-"
        }).prefix(24).description
    }

    // MARK: State feed

    /// Same payload shape the VS Code extension posts to the panel.
    func post(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        lastPayload = json
        guard ready, let web = webView else { return }
        web.evaluateJavaScript("window.dispatchEvent(new MessageEvent('message',{data:\(json)}))")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        ready = true
        post0(lastPayload)
    }

    private func post0(_ json: String) {
        webView?.evaluateJavaScript("window.dispatchEvent(new MessageEvent('message',{data:\(json)}))")
    }

    // MARK: Messages from the page

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if body["type"] as? String == "rect",
           let x = body["x"] as? Double, let y = body["y"] as? Double,
           let w = body["w"] as? Double, let h = body["h"] as? Double,
           let container {
            // CSS coordinates (top-left origin) → AppKit view coordinates.
            let pad: CGFloat = 4
            container.hotRect = NSRect(x: x - pad,
                                       y: container.bounds.height - y - h - pad,
                                       width: w + pad * 2, height: h + pad * 2)
        }
    }
}

/// Lets every click through to the app underneath, except over `hotRect`.
final class PassthroughView: NSView {
    var hotRect: NSRect = .zero

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        guard hotRect.contains(local) else { return nil }
        return super.hitTest(point)
    }
}

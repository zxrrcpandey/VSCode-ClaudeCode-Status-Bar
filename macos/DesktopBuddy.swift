// Desktop buddy: the character roaming your actual screens, above every app.
//
// The animation, art and dialogue are the shared buddy.html — the same file
// the VS Code panel uses — hosted in transparent, borderless, always-on-top
// panels. Screen edges become its floor, walls and ceiling, so it walks along
// the bottom, climbs the sides and hangs from the top.
//
// One panel PER SCREEN. macOS defaults to "Displays have separate Spaces",
// under which a window cannot span two displays: it is pinned to one and
// clipped there, so a single wide window makes the buddy vanish whenever it
// wanders onto the other screen. Instead each screen gets its own panel and
// the buddy migrates between them, entering from the facing edge.
//
// Clicks pass straight through to whatever is underneath: the panels ignore
// mouse events except while the cursor is actually over the character.

import AppKit
import WebKit

/// One screen's transparent panel and the page inside it.
final class BuddyScreen {
    let panel: NSPanel
    let web: WKWebView
    let container: PassthroughView
    var hotRect: NSRect = .zero
    var lastRectAt = Date.distantPast
    var ready = false
    /// Set while the character has not moved — a natural moment to migrate.
    var lastX: Double = -1
    var stillSince = Date.distantPast

    init(panel: NSPanel, web: WKWebView, container: PassthroughView) {
        self.panel = panel; self.web = web; self.container = container
    }
}

final class DesktopBuddy: NSObject, WKScriptMessageHandler, WKNavigationDelegate {

    private var screens: [BuddyScreen] = []
    private var active = 0
    private var lastPayload: String = "{}"
    private var timer: Timer?
    private var nextMigration = Date.distantFuture
    private var migrationDue = false
    private var lastHoverPause = Date.distantPast
    /// How close the cursor must get before the character stops to be clicked.
    /// `defaults write com.warroom.claude-pulse buddyNoticeRadius -float 200`
    /// makes it notice you sooner; a small value makes it harder to catch.
    static var noticeRadius: CGFloat {
        let v = UserDefaults.standard.object(forKey: "buddyNoticeRadius") as? Double ?? 0
        return v > 0 ? CGFloat(v) : 130
    }
    private var lastDebugAt = Date.distantPast

    /// `defaults write com.warroom.claude-pulse buddyDebug -bool true` writes a
    /// trace to ~/.claude/claude-pulse/buddy-debug.log (hover, clicks, hop).
    private var debugLogging: Bool { UserDefaults.standard.bool(forKey: "buddyDebug") }

    private func rectStr(_ r: NSRect) -> String {
        "(\(Int(r.minX)),\(Int(r.minY)) \(Int(r.width))x\(Int(r.height)))"
    }

    private func log(_ line: String) {
        guard debugLogging else { return }
        let path = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".claude/claude-pulse/buddy-debug.log")
        let stamp = ISO8601DateFormatter().string(from: Date())
        guard let data = ("\(stamp) \(line)\n").data(using: .utf8) else { return }
        if let h = try? FileHandle(forWritingTo: path) {
            h.seekToEndOfFile(); try? h.write(contentsOf: data); try? h.close()
        } else {
            try? data.write(to: path)
        }
    }

    static let characters = ["critter", "robot", "cat", "pup", "turtle", "snail", "bee", "dragon", "ghost"]

    var isVisible: Bool { screens.indices.contains(active) && screens[active].panel.isVisible }

    // MARK: Lifecycle

    func toggle() { isVisible ? hide() : show() }

    func show() {
        if screens.isEmpty { build() }
        guard screens.indices.contains(active) else { return }
        screens[active].panel.alphaValue = 1
        screens[active].panel.orderFrontRegardless()
        scheduleMigration()
        UserDefaults.standard.set(true, forKey: "buddyVisible")
    }

    func hide() {
        for s in screens { s.panel.orderOut(nil) }
        UserDefaults.standard.set(false, forKey: "buddyVisible")
    }

    /// Rebuild from scratch — character, size or screen layout changed.
    func reload() {
        let wasVisible = isVisible
        teardown()
        if wasVisible { show() }
    }

    private func teardown() {
        timer?.invalidate(); timer = nil
        for s in screens {
            s.panel.orderOut(nil)
            s.web.configuration.userContentController.removeAllUserScripts()
            s.web.configuration.userContentController.removeScriptMessageHandler(forName: "pulse")
        }
        screens.removeAll()
        active = 0
    }

    private func build() {
        for screen in NSScreen.screens {
            let frame = screen.visibleFrame

            let cfg = WKWebViewConfiguration()
            let ucc = WKUserContentController()
            // buddy.html is written for a VS Code webview; give it the same tiny API.
            ucc.addUserScript(WKUserScript(source: """
                window.acquireVsCodeApi = function () {
                  return { postMessage: function (m) { window.webkit.messageHandlers.pulse.postMessage(m); },
                           getState: function () { return null; }, setState: function () {} };
                };
                """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            // Report where the character is: this drives click-through and tells
            // us when it is standing still (a good moment to change screens).
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

            let web = BuddyWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: cfg)
            web.navigationDelegate = self
            web.setValue(false, forKey: "drawsBackground")      // transparent over the desktop
            if #available(macOS 12.0, *) { web.underPageBackgroundColor = .clear }
            web.autoresizingMask = [.width, .height]
            web.loadHTMLString(html(), baseURL: nil)

            let view = PassthroughView(frame: NSRect(origin: .zero, size: frame.size))
            view.addSubview(web)

            // A non-activating panel never steals focus from the app you are using.
            let p = BuddyPanel(contentRect: frame,
                               styleMask: [.borderless, .nonactivatingPanel],
                               backing: .buffered, defer: false)
            p.isOpaque = false
            p.backgroundColor = .clear
            p.hasShadow = false
            // A window only lets clicks reach the app underneath when it ignores
            // mouse events outright — returning nil from hitTest is not enough,
            // it just makes the click land nowhere. Click-through by default;
            // clickable only while the cursor is over the character.
            p.ignoresMouseEvents = true
            p.level = .floating
            p.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
            p.isFloatingPanel = true
            p.hidesOnDeactivate = false
            p.contentView = view
            p.setFrame(frame, display: true)

            screens.append(BuddyScreen(panel: p, web: web, container: view))
        }
        active = min(active, max(0, screens.count - 1))

        let t = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(t, forMode: .common)
        timer = t

        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            // A display was added, removed or rearranged: rebuild the panels so
            // each still matches exactly one screen.
            guard let self, !self.screens.isEmpty else { return }
            self.reload()
        }
    }

    // MARK: Per-frame housekeeping

    private func tick() {
        guard isVisible, screens.indices.contains(active) else { return }
        let s = screens[active]

        // Clickable only while the cursor is actually on the character.
        let mouse = NSEvent.mouseLocation
        let onScreenRect = s.panel.convertToScreen(s.hotRect)
        let over = !s.hotRect.isEmpty && onScreenRect.contains(mouse)
        if s.panel.ignoresMouseEvents == over { s.panel.ignoresMouseEvents = !over }
        // Reach for the buddy and it stops and waits, like a pet noticing your
        // hand. Without this it walks (or climbs) out from under the cursor
        // before the click ever lands — the reason it felt unclickable.
        let near = onScreenRect.insetBy(dx: -Self.noticeRadius, dy: -Self.noticeRadius).contains(mouse)
        if near, Date().timeIntervalSince(lastHoverPause) > 0.2 {
            lastHoverPause = Date()
            s.web.evaluateJavaScript("try { pauseUntil = performance.now() + 700 } catch (e) {}")
        }
        if debugLogging, Date().timeIntervalSince(lastDebugAt) > 0.5 {
            lastDebugAt = Date()
            log("hot=\(rectStr(onScreenRect)) mouse=(\(Int(mouse.x)),\(Int(mouse.y))) over=\(over) near=\(near) ignoresMouse=\(s.panel.ignoresMouseEvents) key=\(s.panel.isKeyWindow)")
        }

        // The page reports its position every 100ms. Silence means the web
        // content process died (window stays up but blank) or the script
        // wedged — reload rather than leaving an empty screen.
        if s.ready, Date().timeIntervalSince(s.lastRectAt) > 5 {
            s.lastRectAt = Date()
            s.hotRect = .zero
            s.panel.ignoresMouseEvents = true
            s.web.loadHTMLString(html(), baseURL: nil)
            return
        }

        guard screens.count > 1 else { return }
        if Date() >= nextMigration { migrationDue = true }
        // Change screens while the character is standing still, so it reads as
        // wandering off rather than teleporting mid-stride. Don't wait forever.
        let stillFor = Date().timeIntervalSince(s.stillSince)
        if migrationDue, stillFor > 0.8 || Date().timeIntervalSince(nextMigration) > 25 {
            migrate()
        }
    }

    private func scheduleMigration() {
        migrationDue = false
        // `defaults write com.warroom.claude-pulse buddyMigrateSeconds -float 20`
        // pins the interval (handy for testing, or if you want a livelier buddy).
        let fixed = UserDefaults.standard.object(forKey: "buddyMigrateSeconds") as? Double ?? 0
        nextMigration = Date().addingTimeInterval(fixed > 0 ? fixed : Double.random(in: 45...150))
    }

    /// Walk the buddy over to the next screen, entering from the facing edge.
    private func migrate() {
        guard screens.count > 1, screens.indices.contains(active) else { return }
        let from = screens[active]
        let next = (active + 1) % screens.count
        let to = screens[next]

        // Enter from the side nearest the screen it came from.
        let entersFromLeft = to.panel.frame.minX >= from.panel.frame.minX
        let entryX = entersFromLeft ? 8 : Int(to.panel.frame.width) - 100
        // `x` is buddy.html's own position variable (a top-level binding, so it
        // is reachable here). If the name ever changes this simply no-ops and
        // the character keeps whatever position it had.
        to.web.evaluateJavaScript("try { x = \(entryX) } catch (e) {}")

        to.panel.alphaValue = 0
        to.panel.orderFrontRegardless()
        active = next
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.35
            to.panel.animator().alphaValue = 1
            from.panel.animator().alphaValue = 0
        } completionHandler: { [weak self] in
            from.panel.orderOut(nil)
            from.panel.alphaValue = 1
            from.panel.ignoresMouseEvents = true
            self?.post0ToActive()
        }
        scheduleMigration()
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
        post0ToActive()
    }

    private func post0ToActive() {
        guard screens.indices.contains(active) else { return }
        let s = screens[active]
        guard s.ready else { return }
        s.web.evaluateJavaScript("window.dispatchEvent(new MessageEvent('message',{data:\(lastPayload)}))")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let s = screens.first(where: { $0.web === webView }) else { return }
        s.ready = true
        s.lastRectAt = Date()
        webView.evaluateJavaScript("window.dispatchEvent(new MessageEvent('message',{data:\(lastPayload)}))")
    }

    /// The web content process can be killed under memory pressure; without
    /// this the window simply goes empty and the buddy "disappears".
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard let s = screens.first(where: { $0.web === webView }) else { return }
        s.ready = false
        s.hotRect = .zero
        s.panel.ignoresMouseEvents = true
        webView.loadHTMLString(html(), baseURL: nil)
    }

    // MARK: Messages from the page

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let web = message.webView,
              let s = screens.first(where: { $0.web === web }) else { return }
        if body["type"] as? String == "poke" {
            log("POKE — the page received a click")
            return
        }
        if body["type"] as? String == "rect",
           let x = body["x"] as? Double, let y = body["y"] as? Double,
           let w = body["w"] as? Double, let h = body["h"] as? Double {
            s.lastRectAt = Date()
            if abs(x - s.lastX) > 1 { s.lastX = x; s.stillSince = Date() }
            // CSS coordinates (top-left origin) → AppKit view coordinates.
            let pad: CGFloat = 10
            let r = NSRect(x: x - pad, y: s.container.bounds.height - y - h - pad,
                           width: w + pad * 2, height: h + pad * 2)
            s.hotRect = r
            s.container.hotRect = r
        }
    }
}

/// Belt and braces alongside `ignoresMouseEvents`: even when the panel is
/// accepting events, only the character's own rectangle is a target.
final class PassthroughView: NSView {
    var hotRect: NSRect = .zero

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        guard hotRect.contains(local) else { return nil }
        return super.hitTest(point)
    }

    // Claude Pulse is an accessory app, so it is never the active app: without
    // this, macOS spends the click activating the window instead of delivering
    // it, and the character can never be clicked.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// Same reason as PassthroughView: the click must reach the page, not be
/// eaten as a window-activating click.
final class BuddyWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// A borderless panel cannot become key by default, and WebKit needs a key
/// window to deliver a proper click. Non-activating means taking key status
/// still does not steal focus from the app you are working in.
final class BuddyPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

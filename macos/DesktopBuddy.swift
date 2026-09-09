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
    /// Last reported character box in the page's own CSS pixels (top-left origin).
    var cssRect: NSRect = .zero
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
    private var screenObserver: NSObjectProtocol?
    private var nextMigration = Date.distantFuture
    private var migrationDue = false
    private var dueSince = Date.distantFuture
    private var finishing = false
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

    /// Character size, as a page zoom (Small 0.7 … Huge 2.4 from the menu).
    static var zoom: CGFloat {
        let v = UserDefaults.standard.object(forKey: "buddyZoom") as? Double ?? 1.0
        return CGFloat(max(0.3, min(4.0, v > 0 ? v : 1.0)))
    }

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
        crossing = nil; finishing = false
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
        crossing = nil; finishing = false; migrationDue = false
        timer?.invalidate(); timer = nil
        if let o = screenObserver { NotificationCenter.default.removeObserver(o); screenObserver = nil }
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
            // Browser-style zoom: the page sees a smaller stage (points / zoom)
            // and everything in it scales together; positions stay coherent.
            web.pageZoom = Self.zoom
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
        log("screens: " + NSScreen.screens.map { rectStr($0.visibleFrame) }.joined(separator: " | ") + " zoom=\(Self.zoom)")

        let t = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(t, forMode: .common)
        timer = t

        // One observer, ever: reload() rebuilds via build(), and without removing
        // the previous observer every character/size change would stack another,
        // so a display change would cascade into N rebuilds.
        if let o = screenObserver { NotificationCenter.default.removeObserver(o) }
        screenObserver = NotificationCenter.default.addObserver(
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
        if Date() >= nextMigration, !migrationDue { migrationDue = true; dueSince = Date() }
        if migrationDue, crossing == nil { beginCrossingIfNear() }
        if let c = crossing, !finishing {
            // Arrived at the edge facing the other screen (in the page's own
            // pixels). The cap is a safety net, not the normal path: crossings
            // only start near the edge, so this should never fire.
            let stageW = Double(s.container.bounds.width) / Double(s.web.pageZoom)
            let atEdge = !s.cssRect.isEmpty &&
                (c.edge < 0 ? s.cssRect.minX <= 12 : s.cssRect.maxX >= stageW - 12)
            if atEdge || Date().timeIntervalSince(c.started) > 60 {
                finishCrossing(c)
            } else if Date().timeIntervalSince(c.lastSteer) > 1 {
                steer(c)
            }
        }
    }

    private func scheduleMigration() {
        migrationDue = false
        dueSince = .distantFuture
        crossing = nil
        finishing = false
        // `defaults write com.warroom.claude-pulse buddyMigrateSeconds -float 20`
        // pins the interval (handy for testing, or if you want a livelier buddy).
        let fixed = UserDefaults.standard.object(forKey: "buddyMigrateSeconds") as? Double ?? 0
        nextMigration = Date().addingTimeInterval(fixed > 0 ? fixed : Double.random(in: 45...150))
    }

    /// A screen change in progress: head for `edge` (-1 left, +1 right) of the
    /// active screen, then continue on screen `to` from its opposite edge.
    private struct Crossing { let to: Int; let edge: Int; let started: Date; var lastSteer: Date }
    private var crossing: Crossing?

    /// Displays side by side: leave by the edge that faces the other screen.
    /// Stacked (same x): there is no facing edge, so use whichever is nearer.
    private func sideBySide(_ a: BuddyScreen, _ b: BuddyScreen) -> Bool {
        abs(b.panel.frame.minX - a.panel.frame.minX) > 100
    }

    private func exitEdge(from: BuddyScreen, to: BuddyScreen, stageW: Double) -> Int {
        if sideBySide(from, to) { return to.panel.frame.minX > from.panel.frame.minX ? 1 : -1 }
        return Double(from.cssRect.midX) < stageW / 2 ? -1 : 1
    }

    /// Start a crossing only once the character happens to be near the exit
    /// edge (it wanders everywhere, so this comes soon enough), so the trip is
    /// a few seconds of dash/flight rather than a long march that ends in a
    /// mid-screen teleport when a timeout fires. After a long wait, go anyway.
    private func beginCrossingIfNear() {
        guard screens.count > 1, screens.indices.contains(active) else { return }
        let from = screens[active]
        guard !from.cssRect.isEmpty else { return }
        let next = (active + 1) % screens.count
        let stageW = Double(from.container.bounds.width) / Double(from.web.pageZoom)
        let edge = exitEdge(from: from, to: screens[next], stageW: stageW)
        let dist = edge < 0 ? Double(from.cssRect.minX) : stageW - Double(from.cssRect.maxX)
        guard dist < 360 || Date().timeIntervalSince(dueSince) > 180 else { return }
        let c = Crossing(to: next, edge: edge, started: Date(), lastSteer: .distantPast)
        crossing = c
        steer(c)
        log("crossing: heading to \(edge > 0 ? "right" : "left") edge for screen \(next) (\(Int(dist))px away)")
    }

    /// Point the character at the edge. These are buddy.html's own top-level
    /// variables; if a name ever changes this no-ops and the crossing simply
    /// happens on the timeout instead.
    private func steer(_ c: Crossing) {
        guard screens.indices.contains(active) else { return }
        crossing?.lastSteer = Date()
        // buddy.html owns its state; steerToEdge() resets what needs resetting.
        screens[active].web.evaluateJavaScript("try { steerToEdge(\(c.edge)) } catch (e) {}")
    }

    /// Swap screens with the character continuing from the facing edge at the
    /// same height — it walks (or flies) off one screen and onto the next.
    private func finishCrossing(_ c: Crossing) {
        guard !finishing, screens.count > 1, screens.indices.contains(active), screens.indices.contains(c.to) else {
            if !finishing { scheduleMigration() }
            return
        }
        finishing = true                    // single-shot: ticks keep coming while the reply is in flight
        let from = screens[active]
        let to = screens[c.to]
        // Side by side: left by the right edge → enter from the left. Stacked:
        // enter on the same side it left, so the hop is short, not diagonal.
        let entersFromLeft = sideBySide(from, to) ? (c.edge > 0) : (c.edge < 0)
        let entryX = entersFromLeft ? "4" : "wallR(Math.max(120, stage.clientWidth))"
        let inward = entersFromLeft ? "264" : "wallR(Math.max(120, stage.clientWidth)) - 260"
        from.web.evaluateJavaScript("(function(){ try { return y } catch (e) { return 0 } })()") { [weak self] res, _ in
            guard let self else { return }
            self.finishing = false
            // A hide()/reload() may have torn everything down while we waited.
            guard self.crossing != nil,
                  self.screens.indices.contains(c.to), self.screens[c.to] === to,
                  self.screens.indices.contains(self.active), self.screens[self.active] === from else {
                self.crossing = nil
                return
            }
            let y = (res as? Double) ?? 0
            to.web.evaluateJavaScript("try { enterAt(\(entryX), \(y), \(inward)) } catch (e) {}")
            to.panel.orderFrontRegardless()
            self.active = c.to
            from.panel.orderOut(nil)
            from.panel.ignoresMouseEvents = true
            self.post0ToActive()
            self.log("crossed to screen \(c.to) at y=\(Int(y))")
            self.scheduleMigration()
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
        // Size is applied with WKWebView.pageZoom, NOT CSS zoom on the sprite:
        // CSS zoom also scales the element's position offsets, which sent a
        // 1.6× bee off the right of the screen and left hearts, flowers and
        // speech bubbles (placed from the logical position) far from it.
        raw = raw.replacingOccurrences(of: "</head>", with: """
            <style>#floor,#hint{display:none!important}
            html,body{background:transparent!important}</style></head>
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
           let cx = body["x"] as? Double, let cy = body["y"] as? Double,
           let cw = body["w"] as? Double, let ch = body["h"] as? Double {
            s.lastRectAt = Date()
            s.cssRect = NSRect(x: cx, y: cy, width: cw, height: ch)
            if abs(cx - s.lastX) > 1 { s.lastX = cx; s.stillSince = Date() }
            // CSS pixels → view points (× page zoom), top-left → bottom-left origin.
            let z = Double(web.pageZoom)
            let x = cx * z, y = cy * z, w = cw * z, h = ch * z
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

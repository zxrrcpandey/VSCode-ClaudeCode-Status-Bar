// The big warning. When a plan limit is close, or a conversation has grown so
// large that every reply mostly re-reads it, Claude Pulse puts a card on every
// screen that says what is happening and what to do about it.
//
// Deliberately plain AppKit rather than a web view: the desktop buddy's web
// content process can be killed under memory pressure and the window simply
// goes blank. A warning that silently disappears is worse than no warning.
//
// It never activates the app, so it cannot steal focus or a keystroke from
// whatever you are typing into.
//
// It can be dragged anywhere on its screen by any part except a button, and
// each screen remembers where its card was left, so a card that covered
// something once does not come back over it. Double-click puts it back at the
// top.

import AppKit

struct BannerAction {
    var title: String
    var prominent = false
    var run: () -> Void
}

struct BannerSpec {
    /// Identity, for snoozing and for not showing the same thing twice:
    /// "weekly", "session", "blocked", "compact:<session id>".
    var kind: String
    var accent: NSColor
    var icon: String
    var title: String
    var body: String
    /// 0-1, drawn as a gauge. nil hides it.
    var fill: Double?
    var fillLabel: String?
    var actions: [BannerAction]
    /// Warnings fade by themselves; being blocked stays until acknowledged.
    var autoDismiss: TimeInterval?
}

final class AlertBanner: NSObject {
    private var panels: [NSPanel] = []
    private var actions: [BannerAction] = []
    private var dismissTimer: Timer?
    private var screenObserver: NSObjectProtocol?
    private(set) var showing: String?

    var isVisible: Bool { !panels.isEmpty }

    // MARK: Show / hide

    func show(_ spec: BannerSpec) {
        hide()
        showing = spec.kind
        actions = spec.actions

        for screen in NSScreen.screens {
            let card = buildCard(spec)
            // buildCard lays its children out by frame, not by constraints, so
            // it is `frame` that carries the size it worked out — fittingSize
            // is zero for a view with no constraints, which gave a 0x0 panel.
            let size = card.frame.size
            let panel = BannerPanel(contentRect: NSRect(origin: .zero, size: size),
                                    styleMask: [.borderless, .nonactivatingPanel],
                                    backing: .buffered, defer: false)
            panel.area = screen.visibleFrame
            panel.display = Self.displayKey(screen)
            let origin = place(panel, size: size)
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = true
            panel.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 1)
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
            panel.isFloatingPanel = true
            panel.hidesOnDeactivate = false
            // The card drags itself (BannerContentView), so that it stays on
            // its own screen and knows when a drag has finished.
            panel.isMovableByWindowBackground = false
            card.onMoved = { [weak self, weak panel] in
                if let self, let panel { self.remember(panel) }
            }
            card.onReset = { [weak self, weak panel] in
                if let self, let panel { self.forget(panel) }
            }
            panel.contentView = card
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            // Slide down a little as it fades in, so it reads as arriving.
            panel.setFrame(NSRect(origin: NSPoint(x: origin.x, y: origin.y + 14), size: size), display: false)
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.22
                panel.animator().alphaValue = 1
                panel.animator().setFrame(NSRect(origin: origin, size: size), display: true)
            }
            panels.append(panel)
        }

        if let after = spec.autoDismiss {
            dismissTimer = Timer.scheduledTimer(withTimeInterval: after, repeats: false) { [weak self] _ in
                self?.hide()
            }
            if let t = dismissTimer { RunLoop.main.add(t, forMode: .common) }
        }

        // A display being unplugged would leave a panel sized and placed for a
        // screen that no longer exists. Put it back up to match the new layout.
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self, self.isVisible else { return }
            self.show(spec)
        }
    }

    func hide() {
        if let o = screenObserver { NotificationCenter.default.removeObserver(o); screenObserver = nil }
        dismissTimer?.invalidate(); dismissTimer = nil
        let going = panels
        panels.removeAll()
        showing = nil
        actions.removeAll()
        guard !going.isEmpty else { return }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.15
            for p in going { p.animator().alphaValue = 0 }
        }, completionHandler: {
            for p in going { p.orderOut(nil) }
        })
    }

    // MARK: Where it sits

    /// Where each screen's card was last left, keyed by display, as fractions
    /// of the room the card has to move in: 0 is the left or bottom edge, 1
    /// the right or top. Fractions rather than points, so a taller card or a
    /// changed resolution still lands in the same corner.
    private static let spotsKey = "bannerSpots"

    private static func displayKey(_ screen: NSScreen) -> String? {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.stringValue
    }

    /// Near the top, centred: where macOS puts things you must notice.
    private static func defaultOrigin(_ size: NSSize, in area: NSRect) -> NSPoint {
        NSPoint(x: area.midX - size.width / 2, y: area.maxY - size.height - 48)
    }

    private func place(_ panel: BannerPanel, size: NSSize) -> NSPoint {
        let area = panel.area
        let spots = UserDefaults.standard.dictionary(forKey: Self.spotsKey) as? [String: [Double]]
        guard let key = panel.display, let s = spots?[key], s.count == 2 else {
            return panel.clamp(Self.defaultOrigin(size, in: area), size: size)
        }
        return panel.clamp(NSPoint(x: area.minX + CGFloat(s[0]) * max(0, area.width - size.width),
                                   y: area.minY + CGFloat(s[1]) * max(0, area.height - size.height)),
                           size: size)
    }

    private func remember(_ panel: BannerPanel) {
        guard let key = panel.display else { return }
        let f = panel.frame, area = panel.area
        let roomX = area.width - f.width, roomY = area.height - f.height
        let fx = roomX > 0 ? Double((f.minX - area.minX) / roomX) : 0.5
        let fy = roomY > 0 ? Double((f.minY - area.minY) / roomY) : 1
        var spots = UserDefaults.standard.dictionary(forKey: Self.spotsKey) as? [String: [Double]] ?? [:]
        spots[key] = [max(0, min(1, fx)), max(0, min(1, fy))]
        UserDefaults.standard.set(spots, forKey: Self.spotsKey)
    }

    private func forget(_ panel: BannerPanel) {
        if let key = panel.display,
           var spots = UserDefaults.standard.dictionary(forKey: Self.spotsKey) as? [String: [Double]] {
            spots[key] = nil
            UserDefaults.standard.set(spots, forKey: Self.spotsKey)
        }
        let size = panel.frame.size
        let home = panel.clamp(Self.defaultOrigin(size, in: panel.area), size: size)
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.2
            panel.animator().setFrame(NSRect(origin: home, size: size), display: true)
        }
    }

    // MARK: Layout

    private func buildCard(_ spec: BannerSpec) -> BannerContentView {
        let width: CGFloat = 820
        let pad: CGFloat = 26

        let root = BannerContentView()
        root.wantsLayer = true

        let blur = NSVisualEffectView()
        blur.material = .hudWindow
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.wantsLayer = true
        blur.layer?.cornerRadius = 18
        blur.layer?.masksToBounds = true
        blur.layer?.borderWidth = 1
        blur.layer?.borderColor = spec.accent.withAlphaComponent(0.55).cgColor
        root.addSubview(blur)

        // A thick colour bar down the left edge carries the severity at a glance.
        let stripe = NSView()
        stripe.wantsLayer = true
        stripe.layer?.backgroundColor = spec.accent.cgColor
        root.addSubview(stripe)

        // The grab bar along the top: says "this can be moved" without words.
        let grip = GripView()
        root.addSubview(grip)

        let iconLabel = NSTextField(labelWithString: spec.icon)
        iconLabel.font = .systemFont(ofSize: 40)
        iconLabel.alignment = .center
        root.addSubview(iconLabel)

        let titleLabel = NSTextField(labelWithString: spec.title)
        titleLabel.font = .systemFont(ofSize: 25, weight: .semibold)
        titleLabel.textColor = .labelColor
        titleLabel.lineBreakMode = .byTruncatingTail
        root.addSubview(titleLabel)

        let bodyLabel = NSTextField(wrappingLabelWithString: spec.body)
        bodyLabel.font = .systemFont(ofSize: 14)
        bodyLabel.textColor = .secondaryLabelColor
        bodyLabel.isSelectable = false
        root.addSubview(bodyLabel)

        var gauge: GaugeView?
        if let fill = spec.fill {
            let g = GaugeView()
            g.fill = max(0, min(1, fill))
            g.accent = spec.accent
            g.label = spec.fillLabel
            root.addSubview(g)
            gauge = g
        }

        var buttons: [NSButton] = []
        for (i, a) in spec.actions.enumerated() {
            let b = BannerButton(title: a.title, target: self, action: #selector(tap(_:)))
            b.tag = i
            b.bezelStyle = .rounded
            b.controlSize = .large
            b.font = .systemFont(ofSize: 13, weight: a.prominent ? .semibold : .regular)
            if a.prominent { b.bezelColor = spec.accent }
            root.addSubview(b)
            buttons.append(b)
        }

        // Plain frame maths: one card, fixed width, nothing resizes.
        let textX = pad + 12 + 54
        let textW = width - textX - pad
        titleLabel.frame = NSRect(x: textX, y: 0, width: textW, height: 30)
        bodyLabel.frame = NSRect(x: textX, y: 0, width: textW, height: 0)
        bodyLabel.frame.size.height = bodyLabel.sizeThatFits(NSSize(width: textW, height: .greatestFiniteMagnitude)).height

        var y = pad
        var buttonsH: CGFloat = 0
        if !buttons.isEmpty {
            buttonsH = 32
            var x = width - pad
            // Laid out right to left so the primary action sits at the edge.
            for b in buttons.reversed() {
                b.sizeToFit()
                let w = max(96, b.frame.width + 26)
                x -= w
                b.frame = NSRect(x: x, y: y, width: w, height: buttonsH)
                x -= 10
            }
            y += buttonsH + 18
        }
        if let g = gauge {
            g.frame = NSRect(x: textX, y: y, width: textW, height: 22)
            y += 22 + 14
        }
        bodyLabel.frame.origin.y = y
        y += bodyLabel.frame.height + 10
        titleLabel.frame.origin.y = y
        y += titleLabel.frame.height + pad

        let height = y
        root.frame = NSRect(x: 0, y: 0, width: width, height: height)
        blur.frame = root.bounds
        stripe.frame = NSRect(x: 0, y: 0, width: 7, height: height)
        grip.frame = NSRect(x: (width - 44) / 2, y: height - 9 - 5, width: 44, height: 5)
        iconLabel.frame = NSRect(x: pad + 4, y: height - pad - 46, width: 54, height: 46)
        return root
    }

    @objc private func tap(_ sender: NSButton) {
        guard actions.indices.contains(sender.tag) else { hide(); return }
        let action = actions[sender.tag]
        hide()
        action.run()
    }
}

// MARK: - Pieces

/// A flat percentage gauge: the bar fills with the severity colour and the
/// remainder stays grey, so "how much is left" is visible without reading.
final class GaugeView: NSView {
    var fill: Double = 0
    var accent: NSColor = .systemOrange
    var label: String?

    override var isFlipped: Bool { false }

    override func draw(_ dirty: NSRect) {
        let barH: CGFloat = 10
        var barW = bounds.width
        if let label, !label.isEmpty {
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium),
                .foregroundColor: NSColor.secondaryLabelColor,
            ]
            let s = NSAttributedString(string: label, attributes: attrs)
            let size = s.size()
            s.draw(at: NSPoint(x: bounds.maxX - size.width, y: bounds.midY - size.height / 2))
            barW -= size.width + 12
        }
        let y = bounds.midY - barH / 2
        let track = NSBezierPath(roundedRect: NSRect(x: 0, y: y, width: barW, height: barH),
                                 xRadius: barH / 2, yRadius: barH / 2)
        NSColor.labelColor.withAlphaComponent(0.14).setFill()
        track.fill()
        guard fill > 0 else { return }
        let w = max(barH, barW * CGFloat(fill))
        let bar = NSBezierPath(roundedRect: NSRect(x: 0, y: y, width: w, height: barH),
                               xRadius: barH / 2, yRadius: barH / 2)
        accent.setFill()
        bar.fill()
    }
}

final class GripView: NSView {
    override func draw(_ dirty: NSRect) {
        NSColor.tertiaryLabelColor.setFill()
        NSBezierPath(roundedRect: bounds, xRadius: bounds.height / 2, yRadius: bounds.height / 2).fill()
    }
}

/// The card itself, and the handle it is dragged by. Every part of it except
/// a button answers the mouse here, so the title and the text move it too —
/// the whole card is a handle, not just the bar along the top.
///
/// Claude Pulse is an accessory app and never the active one, so without
/// acceptsFirstMouse the first click is spent activating the window instead
/// of pressing the button — exactly the bug the desktop buddy had.
final class BannerContentView: NSView {
    var onMoved: (() -> Void)?
    var onReset: (() -> Void)?

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let hit = super.hitTest(point) else { return nil }
        return hit is NSButton ? hit : self
    }

    override func mouseDown(with event: NSEvent) {
        guard let panel = window as? BannerPanel else { return }
        if event.clickCount == 2 { onReset?(); return }
        let grabbed = NSEvent.mouseLocation
        let from = panel.frame.origin
        var moved = false
        // Follow the mouse until it is let go. Kept on the card's own screen,
        // whole: a card half off the edge, or carried onto the other display
        // to sit on top of that screen's card, helps nobody.
        while let e = panel.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]),
              e.type == .leftMouseDragged {
            let p = NSEvent.mouseLocation
            panel.setFrameOrigin(panel.clamp(NSPoint(x: from.x + p.x - grabbed.x,
                                                     y: from.y + p.y - grabbed.y),
                                             size: panel.frame.size))
            moved = true
        }
        if moved { onMoved?() }
    }
}

final class BannerButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class BannerPanel: NSPanel {
    /// The visible frame of the screen this card was made for.
    var area: NSRect = .zero
    /// That screen's display number, which its remembered spot is filed under.
    var display: String?

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    func clamp(_ origin: NSPoint, size: NSSize) -> NSPoint {
        guard area.width > 0 else { return origin }
        return NSPoint(x: max(area.minX, min(origin.x, area.maxX - size.width)),
                       y: max(area.minY, min(origin.y, area.maxY - size.height)))
    }
}

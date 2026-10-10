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
            let vf = screen.visibleFrame
            // Near the top, centred: where macOS puts things you must notice.
            let origin = NSPoint(x: vf.midX - size.width / 2,
                                 y: vf.maxY - size.height - 48)
            let panel = BannerPanel(contentRect: NSRect(origin: origin, size: size),
                                    styleMask: [.borderless, .nonactivatingPanel],
                                    backing: .buffered, defer: false)
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = true
            panel.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 1)
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
            panel.isFloatingPanel = true
            panel.hidesOnDeactivate = false
            panel.isMovableByWindowBackground = true
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

    // MARK: Layout

    private func buildCard(_ spec: BannerSpec) -> NSView {
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

/// Claude Pulse is an accessory app and never the active one, so without this
/// the first click is spent activating the window instead of pressing the
/// button — exactly the bug the desktop buddy had.
final class BannerContentView: NSView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class BannerButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class BannerPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

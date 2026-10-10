// When to speak up about usage, and what to say.
//
// The rules exist to keep the warning believable. It fires once per step up
// (a warning does not nag, but getting worse does re-fire), it can be snoozed,
// it remembers across restarts so quitting the app is not a way to reset the
// nagging, and below the watch threshold it says nothing at all.
//
// Everything here is advice the user can act on in the next minute: slow down,
// switch model, take the break the 5-hour window is forcing anyway, or compact
// a conversation that has grown expensive to carry.

import AppKit
import UserNotifications

extension AppDelegate {

    // MARK: Remembering what we already said

    private var shownKeys: [String: Double] {
        get { (UserDefaults.standard.dictionary(forKey: "limitShown") as? [String: Double]) ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: "limitShown") }
    }

    private var snoozes: [String: Double] {
        get { (UserDefaults.standard.dictionary(forKey: "limitSnooze") as? [String: Double]) ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: "limitSnooze") }
    }

    /// A step we have already shown stays quiet for half a day; after that the
    /// situation is new enough to be worth repeating.
    private func alreadyShown(_ key: String) -> Bool {
        let now = Date().timeIntervalSince1970 * 1000
        guard let at = shownKeys[key] else { return false }
        return now - at < 12 * 60 * 60_000
    }

    private func markShown(_ key: String) {
        let now = Date().timeIntervalSince1970 * 1000
        var keys = shownKeys.filter { now - $0.value < 3 * 24 * 60 * 60_000 }
        keys[key] = now
        shownKeys = keys
    }

    private func snoozed(_ kind: String) -> Bool {
        let now = Date().timeIntervalSince1970 * 1000
        return (snoozes[kind] ?? 0) > now
    }

    func snooze(_ kind: String, hours: Double) {
        let now = Date().timeIntervalSince1970 * 1000
        var s = snoozes.filter { $0.value > now }
        s[kind] = now + hours * 60 * 60_000
        snoozes = s
    }

    // MARK: The decision

    func evaluateAlerts() {
        guard policy.alertsEnabled else { banner.hide(); return }
        let r = limits.report
        guard r.available else { return }
        let now = Date().timeIntervalSince1970 * 1000

        // Already refused by the server — the one case that is certain.
        if let b = r.blocked {
            let key = "blocked:\(Int(b.resetsAt / 60_000))"
            if !snoozed("blocked"), !alreadyShown(key) {
                markShown(key)
                present(blockedSpec(b, r))
            }
            return
        }

        // A limit window worth interrupting for. The tier is part of the key,
        // so crossing from warn into critical speaks again.
        let (tier, win) = policy.tier(r)
        if tier >= .warn, let w = win {
            let key = "\(w.key):\(tier.rawValue)"
            if !snoozed(w.key), !alreadyShown(key) {
                markShown(key)
                present(limitSpec(w, tier: tier, report: r))
                return
            }
        }

        // Nothing urgent about the plan: is a conversation carrying so much
        // context that every reply mostly pays to re-read it?
        for s in policy.bloated(r, now: now) {
            // Re-arm every 250k tokens, so one chat can warn more than once as
            // it keeps growing, without warning every minute.
            let step = s.ctx / 250_000
            let key = "compact:\(s.id):\(step)"
            if snoozed("compact:\(s.id)") || alreadyShown(key) { continue }
            markShown(key)
            present(compactSpec(s))
            return
        }
    }

    private func present(_ spec: BannerSpec) {
        banner.show(spec)
        // Also in Notification Centre: the banner can be missed behind a
        // full-screen app or while the Mac is locked.
        guard UserDefaults.standard.object(forKey: "limitNotify") == nil
                || UserDefaults.standard.bool(forKey: "limitNotify") else { return }
        let c = UNMutableNotificationContent()
        c.title = spec.title
        c.body = spec.body
        c.sound = .default
        if #available(macOS 12.0, *) { c.interruptionLevel = .timeSensitive }
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: "pulse-limit-\(spec.kind)-\(Int(Date().timeIntervalSince1970))",
                                  content: c, trigger: nil))
    }

    // MARK: What it says

    /// Most of the week on Opus is the single biggest lever most people have,
    /// so the warnings mention it when it is true.
    private func opusShare() -> Double {
        let rows = usage.sum(days: 7)
        let total = rows.reduce(0.0) { $0 + $1.out }
        guard total > 1000 else { return 0 }
        return rows.filter { $0.model.lowercased().contains("opus") }.reduce(0.0) { $0 + $1.out } / total
    }

    private func modelHint() -> String {
        opusShare() >= 0.6
            ? " Nearly all of your week has been Opus — moving routine work to Sonnet costs a fraction of the budget."
            : ""
    }

    /// A session left on Max or Extra effort is the other big multiplier —
    /// Claude Code's own model catalog warns Max "can consume 3.5× or more
    /// usage than Medium".
    private func effortHint() -> String {
        let now = Date().timeIntervalSince1970 * 1000
        guard let hot = limits.report.sessions.first(where: {
            ($0.effort == "max" || $0.effort == "xhigh") && now - $0.updatedAt < 60 * 60_000
        }), let e = hot.effort else { return "" }
        let name = e == "max" ? "Max" : "Extra"
        return " \(hot.project) is set to \(name) effort, which on its own can cost several times what Medium does."
    }

    private func rateLine(_ w: LimitWindow) -> String {
        let refill = w.resetsAt > 0
            ? "It refills in \(LimitFmt.until(w.resetsAt)), at \(LimitFmt.clock(w.resetsAt))."
            : ""
        // With no measured pace yet, say the plain facts rather than invent one.
        guard w.calibrated, let rate = w.burnPerHour, rate > 0.05 else { return refill }
        let pace = rate >= 1 ? String(format: "%.0f%% an hour", rate) : String(format: "%.1f%% an hour", rate)
        guard let out = w.exhaustAt, w.resetsAt > 0 else { return "You are using about \(pace). " + refill }
        if w.beatsReset {
            return "You are using about \(pace), so at this pace it runs out around \(LimitFmt.clock(out)) — "
                + "and it does not refill until \(LimitFmt.clock(w.resetsAt)), \(LimitFmt.until(w.resetsAt)) away."
        }
        return "You are using about \(pace), which still gets you to the refill in \(LimitFmt.until(w.resetsAt))."
    }

    private func dismissActions(_ kind: String) -> [BannerAction] {
        [
            BannerAction(title: "Snooze 1 hour") { [weak self] in self?.snooze(kind, hours: 1) },
            BannerAction(title: "Got it", prominent: true) { },
        ]
    }

    private func limitSpec(_ w: LimitWindow, tier: LimitTier, report: LimitReport) -> BannerSpec {
        let critical = tier >= .critical
        let pct = w.shown
        let left = max(0, 100 - pct)
        var body: String
        var title: String

        if w.key == "session" {
            // The short window is the one that actually blocks people, and the
            // honest advice is different: it is a break, not a budget problem.
            title = critical ? "5-hour limit almost gone — \(pct)%" : "5-hour limit \(pct)% used"
            body = "This is the short window, so time fixes it: it refills in \(LimitFmt.until(w.resetsAt)), "
                + "at \(LimitFmt.clock(w.resetsAt)). "
            if let wk = report.weekly, wk.shown < 70 {
                body += "Your week is only \(wk.shown)% used, so there is plenty waiting for you after that."
            } else if let wk = report.weekly {
                body += "Your week is at \(wk.shown)%, so go carefully after it refills too."
            }
            body += effortHint()
        } else if critical {
            title = "Weekly limit almost gone — \(pct)%"
            body = "About \(left)% left, and the week does not refill for \(LimitFmt.until(w.resetsAt)) "
                + "(\(LimitFmt.clock(w.resetsAt))). Spend what is left on what matters most."
                + modelHint() + effortHint()
        } else {
            title = "\(w.label.prefix(1).uppercased() + w.label.dropFirst()) \(pct)% used"
            // Joined rather than concatenated: any of these can be empty, and
            // gluing them produces a leading space or an empty banner body.
            body = [rateLine(w), modelHint(), effortHint()]
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
                .joined(separator: " ")
            if body.isEmpty { body = "Worth keeping an eye on from here." }
        }
        if let m = w.model { title = "Weekly \(m) limit \(pct)% used" }
        if !w.calibrated, let age = report.ageMs, report.stale {
            body += " (Claude Code last checked this \(LimitFmt.ago(age)) ago.)"
        }

        var actions = dismissActions(w.key)
        actions.insert(BannerAction(title: "See my usage") {
            if let u = URL(string: "https://claude.ai/settings/usage") { NSWorkspace.shared.open(u) }
        }, at: 0)

        return BannerSpec(
            kind: w.key,
            accent: critical ? .systemRed : .systemOrange,
            icon: critical ? "🚨" : "⚠️",
            title: title,
            body: body,
            fill: Double(pct) / 100,
            fillLabel: w.resetsAt > 0 ? "\(pct)% · refills in \(LimitFmt.until(w.resetsAt))" : "\(pct)%",
            actions: actions,
            // A critical warning stays until it is acknowledged.
            autoDismiss: critical ? nil : 75)
    }

    private func blockedSpec(_ b: BlockedInfo, _ r: LimitReport) -> BannerSpec {
        let which = b.kind == "five_hour" ? "5-hour" : b.kind == "seven_day" ? "weekly" : b.kind
        var body = b.resetsAt > 0
            ? "The \(which) limit is used up. It frees up at \(LimitFmt.clock(b.resetsAt)) — \(LimitFmt.until(b.resetsAt)) from now."
            : "The \(which) limit is used up."
        // Worth saying plainly: being stopped by the short window is not the
        // same as being out of weekly budget, and people conflate the two.
        if b.kind == "five_hour", let wk = r.weekly, wk.shown < 80 {
            body += " This is only the 5-hour window — your week is \(wk.shown)% used, so you pick up where you left off."
        }
        if b.noCredits && !r.creditsEnabled {
            body += " Extra usage credits are off, so there is no fallback until then."
        }
        return BannerSpec(
            kind: "blocked",
            accent: .systemRed,
            icon: "⛔",
            title: b.resetsAt > 0 ? "Claude is paused until \(LimitFmt.clock(b.resetsAt))" : "Claude usage limit reached",
            body: body,
            fill: 1,
            fillLabel: b.resetsAt > 0 ? "back in \(LimitFmt.until(b.resetsAt))" : nil,
            actions: [
                BannerAction(title: "See my usage") {
                    if let u = URL(string: "https://claude.ai/settings/usage") { NSWorkspace.shared.open(u) }
                },
                BannerAction(title: "OK", prominent: true) { },
            ],
            autoDismiss: nil)
    }

    private func compactSpec(_ s: SessionContext) -> BannerSpec {
        let share = Int((s.contextShare * 100).rounded())
        return BannerSpec(
            kind: "compact:\(s.id)",
            accent: .systemBlue,
            icon: "🧹",
            title: "This chat now costs \(LimitFmt.tokens(s.ctx)) tokens a reply",
            body: "In \(s.project), about \(share)% of every reply is Claude re-reading the conversation so far — "
                + "you pay for all of it, every turn. Type /compact in that session: it keeps a summary, "
                + "drops the rest, and the next replies cost a fraction of this.",
            fill: nil,
            fillLabel: nil,
            actions: [
                BannerAction(title: "Copy “/compact”") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString("/compact", forType: .string)
                },
                BannerAction(title: "Not this chat") { [weak self] in self?.snooze("compact:\(s.id)", hours: 12) },
                BannerAction(title: "Later", prominent: true) { [weak self] in self?.snooze("compact:\(s.id)", hours: 1) },
            ],
            autoDismiss: 90)
    }

    // MARK: The dropdown section

    /// Rows for the menu: every window, the burn rate, and where the week went.
    func limitMenuRows(_ menu: NSMenu) {
        let r = limits.report
        guard r.available else {
            if limits.available {
                menu.addItem(header("PLAN LIMITS"))
                menu.addItem(detail("no usage data yet — Claude Code caches it as it runs"))
                menu.addItem(NSMenuItem.separator())
            }
            return
        }
        menu.addItem(header("PLAN LIMITS" + (r.plan.map { $0.contains("max_20x") ? " · MAX 20×" : "" } ?? "")))

        if let b = r.blocked, b.resetsAt > 0 {
            menu.addItem(detail("⛔ blocked — back at \(LimitFmt.clock(b.resetsAt)) (\(LimitFmt.until(b.resetsAt)))"))
        }
        for w in r.windows {
            let row = detail(Self.windowLine(w))
            menu.addItem(row)
            liveRows.append((row, { [weak self] in
                guard let cur = self?.limits.report.windows.first(where: { $0.key == w.key }) else { return nil }
                return Self.windowLine(cur)
            }, true))
            if w.calibrated, let rate = w.burnPerHour, rate > 0.05, let out = w.exhaustAt {
                menu.addItem(detail(String(format: "%@%.1f%%/h → empty around %@",
                                           w.beatsReset ? "⚠ " : "", rate, LimitFmt.clock(out)), indent: 2))
            }
        }
        if !r.breakdown.isEmpty {
            menu.addItem(detail("this week: " + r.breakdown.map { "\($0.label) \($0.percent)%" }.joined(separator: " · ")))
        }
        if r.stale, let age = r.ageMs {
            menu.addItem(detail("as of \(LimitFmt.ago(age)) ago — refreshes as Claude Code runs"))
        }
        // The expensive-conversation hint, whether or not it has warned yet.
        let now = Date().timeIntervalSince1970 * 1000
        for s in r.sessions.prefix(3) where s.ctx >= 120_000 && now - s.updatedAt < 60 * 60_000 {
            menu.addItem(detail("\(s.project): \(LimitFmt.tokens(s.ctx)) context · "
                                + "\(Int(s.contextShare * 100))% of every reply is re-reading it", indent: 2))
            if let e = s.effort, e == "max" || e == "xhigh" {
                menu.addItem(detail("↳ \(e) effort — costs several times medium", indent: 3))
            }
        }
        menu.addItem(NSMenuItem.separator())
    }

    /// What the desktop character should know. Only the one step worth
    /// mentioning, so it comments rather than chatters — and nothing at all
    /// while that warning is snoozed.
    func buddyUsage() -> [String: Any]? {
        guard policy.alertsEnabled else { return nil }
        let r = limits.report
        guard r.available else { return nil }
        if let b = r.blocked, !snoozed("blocked") {
            return ["kind": "blocked", "tier": 3, "until": b.resetsAt > 0 ? LimitFmt.until(b.resetsAt) : ""]
        }
        let (tier, win) = policy.tier(r)
        if tier >= .warn, let w = win, !snoozed(w.key) {
            return ["kind": w.key == "session" ? "session" : "weekly", "tier": tier.rawValue,
                    "pct": w.shown, "until": w.resetsAt > 0 ? LimitFmt.until(w.resetsAt) : ""]
        }
        let now = Date().timeIntervalSince1970 * 1000
        if let s = policy.bloated(r, now: now).first, !snoozed("compact:\(s.id)") {
            return ["kind": "compact", "tier": 2, "ctx": LimitFmt.tokens(s.ctx)]
        }
        // No `kind`, so the character stays quiet about it — it only enriches
        // the occasional idle remark.
        if let wk = r.weekly { return ["calm": true, "pct": wk.shown] }
        return nil
    }

    /// One window as a menu row. Says when the figure is the cached one
    /// rather than a live estimate, so the number is never oversold.
    static func windowLine(_ w: LimitWindow) -> String {
        guard w.trusted else {
            // Honest about the gap rather than repeating a number for a window
            // that has already rolled over.
            return "\(w.label): waiting for a fresh reading"
                + (w.resetsAt > 0 ? " · refills in \(LimitFmt.until(w.resetsAt))" : "")
        }
        var l = "\(w.label): \(w.shown)%"
        if let share = w.sharePercent { l += " of its \(Int(share))% share" }
        if !w.calibrated { l += " (last checked)" }
        if w.resetsAt > 0 { l += " · refills in \(LimitFmt.until(w.resetsAt))" }
        return l
    }

    // MARK: Menu actions

    @objc func toggleLimitAlerts(_ sender: NSMenuItem) {
        let on = !policy.alertsEnabled
        UserDefaults.standard.set(on, forKey: "limitAlerts")
        policy = LimitPolicy.load()
        if on {
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
            evaluateAlerts()
        } else {
            banner.hide()
        }
    }

    @objc func toggleContextNudge(_ sender: NSMenuItem) {
        UserDefaults.standard.set(!policy.contextNudge, forKey: "contextNudge")
        policy = LimitPolicy.load()
        if policy.contextNudge { evaluateAlerts() }
    }

    @objc func snoozeAllAlerts(_ sender: NSMenuItem) {
        for kind in ["weekly", "session", "blocked"] { snooze(kind, hours: 4) }
        for s in limits.report.sessions { snooze("compact:\(s.id)", hours: 4) }
        banner.hide()
    }

    /// So the warning can be read, and its wording judged, long before it
    /// matters — and so there is a way to test it without burning a budget.
    @objc func testLimitBanner(_ sender: NSMenuItem) {
        let now = Date().timeIntervalSince1970 * 1000
        let r = limits.report
        var w = r.weekly ?? LimitWindow(key: "weekly", label: "weekly limit", percent: 0)
        if w.shown < 80 {
            // A worked example, with this Mac's real reset time where known.
            w.live = 82
            w.burnPerHour = 2.4
            w.exhaustAt = now + 7.5 * 3_600_000
            w.headroomHours = -45
            w.beatsReset = true
            w.calibrated = true
            if w.resetsAt <= now { w.resetsAt = now + 2.2 * 86_400_000 }
        }
        banner.show(limitSpec(w, tier: .warn, report: r))
    }
}

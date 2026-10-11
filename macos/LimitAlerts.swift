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

        // A reminder with a deadline in it is wrong the moment the deadline
        // passes or the chat is picked up again. Take it down rather than
        // leave it contradicting what is on the screen behind it.
        if let kind = banner.showing, kind.hasPrefix("away:"),
           !policy.goingCold(r, now: now).contains(where: { "away:\($0.id)" == kind }) {
            banner.hide()
        }

        // One thing at a time. Each pass presents the most urgent thing not yet
        // said and marks it said, so the very next pass moves on to the next
        // candidate — which replaced a banner a third of a second after it went
        // up, before anyone could read it. Leave what is on screen alone unless
        // a hard rejection has arrived, which outranks everything.
        if banner.isVisible, r.blocked == nil || banner.showing == "blocked" { return }

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

        // A large conversation about to go cold, while it is still cheap to do
        // something about. Ahead of the nudge below because this one has a
        // deadline — and only with someone at the Mac, because nobody else
        // can act on it in time.
        if LimitPolicy.userIsHere() {
            for s in policy.goingCold(r, now: now) {
                // One reminder per pause: the next reply moves the deadline,
                // and the key with it.
                let key = "away:\(s.id):\(Int(s.cacheExpiresAt / 60_000))"
                if snoozed("away") || snoozed("away:\(s.id)") || alreadyShown(key) { continue }
                markShown(key)
                present(awaySpec(s, now: now))
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
            if snoozed("compact") || snoozed("compact:\(s.id)") || alreadyShown(key) { continue }
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
        // One decimal place everywhere, so the arithmetic in the sentence
        // closes. Rounded to "2% an hour" next to a clock time worked out from
        // 2.4 invites the reader to do the division and catch the warning
        // contradicting itself — in the one screen built to be believed.
        let pace = String(format: "%.1f%% an hour", rate)
        guard let out = w.exhaustAt, w.resetsAt > 0 else { return "You are using about \(pace). " + refill }
        if w.beatsReset {
            return "At the last half-hour's pace — about \(pace) — it runs out around \(LimitFmt.clock(out)), "
                + "and it does not refill until \(LimitFmt.clock(w.resetsAt)), \(LimitFmt.until(w.resetsAt)) away."
        }
        return "At the last half-hour's pace — about \(pace) — it still gets to the refill in \(LimitFmt.until(w.resetsAt))."
    }

    private func dismissActions(_ kind: String) -> [BannerAction] {
        [
            BannerAction(title: "Snooze 1 hour") { [weak self] in self?.snooze(kind, hours: 1) },
            BannerAction(title: "Got it", prominent: true) { },
        ]
    }

    private static func cap(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }

    /// A per-model window's percentage is of that model's slice of the week,
    /// not of the week. Left unsaid, 96% of a half-week allowance reads as
    /// "my week is gone" when half of it is untouched — and the natural
    /// response is to stop working for two days.
    private func sliceLine(_ w: LimitWindow, _ r: LimitReport) -> String {
        guard w.model != nil else { return "" }
        let week = (r.weekly?.trusted ?? false) ? r.weekly?.shown : nil
        if let share = w.sharePercent, share > 0 {
            let of = " That allowance is \(Int(share))% of your week, set aside for this model"
            return week.map { "\(of), and your week overall is \($0)% used." } ?? "\(of)."
        }
        return week.map { " Your week overall is \($0)% used." } ?? ""
    }

    /// Where the figure came from. Once there is a local estimate it is no
    /// longer the server's own answer, and `/usage` will say something a few
    /// points different — which is fine if Pulse said so, and corrosive if it
    /// presented a guess as a fact.
    private func provenance(_ w: LimitWindow, _ r: LimitReport) -> String {
        if w.calibrated, let age = r.ageMs {
            return " (Estimated: Claude Code last checked \(LimitFmt.ago(age)) ago at \(w.percent)%, "
                + "plus what you have spent since.)"
        }
        if let age = r.ageMs, r.stale {
            return " (Claude Code last checked this \(LimitFmt.ago(age)) ago.)"
        }
        return ""
    }

    private func limitSpec(_ w: LimitWindow, tier: LimitTier, report: LimitReport) -> BannerSpec {
        let critical = tier >= .critical
        let pct = w.shown
        let left = max(0, 100 - pct)
        // What the percentage is a percentage of, named the same way in the
        // title and the body.
        let what = w.model.map { "weekly \($0) limit" } ?? w.label
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
            title = "\(Self.cap(what)) almost gone — \(pct)%"
            body = "About \(left)% left, and it does not refill for \(LimitFmt.until(w.resetsAt)) "
                + "(\(LimitFmt.clock(w.resetsAt))). Spend what is left on what matters most."
                + sliceLine(w, report)
                // Naming a model is no help when the limit that bit is that
                // model's own slice.
                + (w.model == nil ? modelHint() : "") + effortHint()
        } else {
            title = "\(Self.cap(what)) \(pct)% used"
            // Joined rather than concatenated: any of these can be empty, and
            // gluing them produces a leading space or an empty banner body.
            body = [rateLine(w), sliceLine(w, report), w.model == nil ? modelHint() : "", effortHint()]
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
                .joined(separator: " ")
            if body.isEmpty { body = "Worth keeping an eye on from here." }
        }
        body += provenance(w, report)

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
            fillLabel: w.resetsAt > 0
                ? "\(w.tag) \(w.shownText) · refills in \(LimitFmt.until(w.resetsAt))"
                : "\(w.tag) \(w.shownText)",
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
        let share = s.contextSharePct
        // Say what was actually measured. Averaged over several replies it is
        // a fact about the conversation; taken from one reply it is a fact
        // about that reply, because output costs five times a cached read and
        // one short answer sends the share to 97% on its own.
        let measured = s.turns >= 3
            ? "In \(s.project), re-reading the conversation has been about \(share)% of the cost of your "
                + "last \(s.turns) replies — you pay for it on every turn."
            : "In \(s.project), the latest reply spent about \(share)% of its cost re-reading the "
                + "conversation so far, and every reply after it pays that again."
        var actions = [
            BannerAction(title: "Copy “/compact”") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString("/compact", forType: .string)
            },
            BannerAction(title: "Not this chat") { [weak self] in self?.snooze("compact:\(s.id)", hours: 12) },
            BannerAction(title: "Later", prominent: true) { [weak self] in self?.snooze("compact:\(s.id)", hours: 1) },
        ]
        // Being asked for the same thing in every long chat is a sign it
        // should not need asking. Claude Code can do it by itself; offer that
        // wherever nothing has been chosen yet.
        let ac = limits.report.autoCompact
        let canAutomate = ac.window == nil && ac.env == nil && !ac.off
        if canAutomate, let size = LimitPolicy.compactPresets.first {
            actions.insert(BannerAction(title: "Always at \(LimitFmt.tokens(size))") { [weak self] in
                self?.applyAutoCompact(size)
            }, at: 1)
        }
        return BannerSpec(
            kind: "compact:\(s.id)",
            accent: .systemBlue,
            icon: "🧹",
            title: "This chat now costs \(LimitFmt.tokens(s.ctx)) tokens a reply",
            body: measured
                + " Type /compact in that session: it keeps a summary, drops the rest, "
                + "and the next replies cost a fraction of this."
                + (canAutomate ? " Or have Claude Code do it by itself from now on." : ""),
            fill: nil,
            fillLabel: nil,
            actions: actions,
            autoDismiss: 90)
    }

    /// The one moment a pause is cheap to prepare for. Says when it ends as a
    /// clock time, so the banner is still true however long it is looked at —
    /// and goes away by itself the minute it would stop being true.
    private func awaySpec(_ s: SessionContext, now: Double, preview: Bool = false) -> BannerSpec {
        let by = LimitFmt.time(s.cacheExpiresAt)
        let kept = s.cacheExpiresAt - s.repliedAt
        let span = abs(kept - 3_600_000) < 60_000 ? "an hour" : "\(max(1, Int(kept / 60_000))) minutes"
        // Only with enough recent replies behind it to mean something.
        let cost = s.reloadTimes.flatMap {
            $0 >= 2 ? " — about what \(Int($0.rounded())) ordinary replies there cost" : nil
        } ?? ""
        let holds = "holds \(LimitFmt.tokens(s.ctx)) tokens. Claude keeps a chat ready for \(span) after each reply; "
        var actions: [BannerAction] = []
        let title: String, body: String
        if s.waitingOnUser {
            title = "Claude is waiting — answer before \(by)"
            body = "\(s.project) asked for your input and \(holds)"
                + "after \(by) it has to load all of that again at full price\(cost). "
                + "Answering before then avoids it."
        } else {
            title = "Stepping away? Compact before \(by)"
            body = "\(s.project) last replied \(LimitFmt.ago(now - s.repliedAt)) ago and \(holds)"
                + "after \(by) your next message there has to load all of it again at full price\(cost). "
                + "Coming back to it later? Type /compact in that chat now, while it is still cheap. "
                + "Finished with it? Then there is nothing to do."
            actions.append(BannerAction(title: "Copy “/compact”") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString("/compact", forType: .string)
            })
        }
        actions.append(BannerAction(title: "Not this chat") { [weak self] in self?.snooze("away:\(s.id)", hours: 12) })
        actions.append(BannerAction(title: "Got it", prominent: true) { })
        return BannerSpec(
            // The preview must not look like a real one to evaluateAlerts,
            // which takes down any "away:" banner whose session has moved on.
            kind: preview ? "away-preview" : "away:\(s.id)",
            accent: .systemTeal,
            icon: "⏳",
            title: title,
            body: body,
            fill: nil,
            fillLabel: nil,
            actions: actions,
            autoDismiss: preview ? 60 : max(20, (s.cacheExpiresAt - now) / 1000))
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
            let row = detail(Self.windowLine(w, ageMs: r.ageMs))
            menu.addItem(row)
            liveRows.append((row, { [weak self] in
                guard let me = self,
                      let cur = me.limits.report.windows.first(where: { $0.key == w.key }) else { return nil }
                return Self.windowLine(cur, ageMs: me.limits.report.ageMs)
            }, true))
            if w.calibrated, let rate = w.burnPerHour, rate > 0.05, let out = w.exhaustAt {
                menu.addItem(detail(String(format: "%@%.1f%%/h → empty around %@",
                                           w.beatsReset ? "⚠ " : "", rate, LimitFmt.clock(out)), indent: 2))
            }
        }
        if !r.breakdown.isEmpty {
            // These are shares of the week's usage and sum to 100 — not shares
            // of the limit. Printed as a bare "Claude Code 88%" under "weekly
            // limit: 8%", two adjacent percentages read as one denominator,
            // and the user who built this because he thought he was pinned at
            // the weekly limit now has UI agreeing with him.
            menu.addItem(detail("where this week's usage went: "
                                + r.breakdown.map { "\($0.label) \($0.percent)%" }.joined(separator: " · ")))
        }
        if r.stale, let age = r.ageMs {
            let how = !policy.autoCheck ? "refreshes as Claude Code runs"
                : r.checkFailed ? "Claude Code did not answer the last check; /usage there does the same"
                : "Pulse asks Claude Code again when more is spent"
            menu.addItem(detail("as of \(LimitFmt.ago(age)) ago — \(how)"))
        }
        if limits.failing, let why = limits.lastError {
            menu.addItem(detail("⚠ these figures have stopped updating: \(why)"))
        }
        // The expensive-conversation hint, whether or not it has warned yet.
        // Kept for as long as the session is known about, not just the first
        // hour: the hour after that is when it has gone cold, which is the
        // thing worth knowing before typing into it again.
        let now = Date().timeIntervalSince1970 * 1000
        var unguarded = false
        for s in r.sessions.prefix(3) where s.ctx >= 120_000 && now - s.updatedAt < 4 * 60 * 60_000 {
            menu.addItem(detail("\(s.project): \(LimitFmt.tokens(s.ctx)) context · "
                                + "\(s.contextSharePct)% of recent replies is re-reading it", indent: 2))
            if let e = s.effort, e == "max" || e == "xhigh" {
                menu.addItem(detail("↳ \(e) effort — costs several times medium", indent: 3))
            }
            if let line = Self.cacheLine(s, now: now) { menu.addItem(detail(line, indent: 3)) }
            if s.ctx >= (LimitPolicy.compactPresets.first ?? 250_000) { unguarded = true }
        }
        // A conversation already past where compacting pays, and nothing set
        // to do it: point at the switch rather than leave it to be found.
        let ac = r.autoCompact
        if unguarded, ac.window == nil, ac.env == nil, !ac.off {
            menu.addItem(detail("↳ nothing compacts these by itself yet — see “Compact Chats Automatically” below",
                                indent: 2))
        }
        menu.addItem(NSMenuItem.separator())
    }

    /// Whether a conversation is still cheap to come back to. Clock times, so
    /// the row stays true while the menu is open.
    static func cacheLine(_ s: SessionContext, now: Double) -> String? {
        guard s.cacheExpiresAt > 0, s.finished || s.waitingOnUser else { return nil }
        let at = LimitFmt.time(s.cacheExpiresAt)
        if s.cacheExpiresAt > now {
            return "↳ cheap to continue until \(at) — then the next message reloads all of it"
        }
        // Compacting now would have to load it all first, so that is no
        // longer the advice. What is still free is not coming back at all.
        return "↳ gone cold at \(at) — the next message reloads all of it. Done with it? Start a new chat"
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
            var payload: [String: Any] = [
                "kind": w.key == "session" ? "session" : "weekly", "tier": tier.rawValue,
                "pct": w.shown, "until": w.resetsAt > 0 ? LimitFmt.until(w.resetsAt) : "",
            ]
            // What the percentage is of, when it is not the whole week.
            if let m = w.model { payload["what"] = "weekly \(m) limit" }
            return payload
        }
        let now = Date().timeIntervalSince1970 * 1000
        if LimitPolicy.userIsHere(), !snoozed("away"),
           let s = policy.goingCold(r, now: now).first(where: { !snoozed("away:\($0.id)") }) {
            return [
                "kind": "away", "tier": 2, "ctx": LimitFmt.tokens(s.ctx), "project": s.project,
                "by": LimitFmt.time(s.cacheExpiresAt), "waiting": s.waitingOnUser,
                // Said once per pause, not once ever: the character keys what
                // it has already said on this.
                "id": "\(s.id):\(Int(s.cacheExpiresAt / 60_000))",
            ]
        }
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
    static func windowLine(_ w: LimitWindow, ageMs: Double? = nil) -> String {
        guard w.trusted else {
            // Honest about the gap rather than repeating a number for a window
            // that has rolled over, or a reading too old to still describe it.
            // Claude Code decides when to refresh that cache on a sampled
            // schedule and can leave it a day or more behind, so name the one
            // thing that fixes it.
            var l = w.label + ": "
            if w.outdated, let age = ageMs {
                l += "last checked \(LimitFmt.ago(age)) ago — run /usage in Claude Code to refresh"
            } else {
                l += "waiting for a fresh reading"
            }
            if w.resetsAt > 0 { l += " · refills in \(LimitFmt.until(w.resetsAt))" }
            return l
        }
        var l = "\(w.label): \(w.shown)%"
        if let share = w.sharePercent { l += " of its \(Int(share))% share" }
        // Which of the two numbers this is. A projection carries the reading it
        // was projected from, so "/usage says 71%" is never a contradiction.
        if w.calibrated {
            l += " (estimated from \(w.percent)% at the last check"
            l += w.calibrationSamples > 0 ? ", \(w.calibrationSamples) readings)" : ")"
        } else {
            l += " (last checked)"
        }
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
        // Every key actually in play, not a fixed list. A Max account reports a
        // per-model window — "weekly_fable" on this one — which a hard-coded
        // ["weekly", "session"] cannot reach, so the banner the user asked to
        // silence would come straight back. The compact nudge is snoozed by a
        // wildcard as well as per session, so a chat that starts after this
        // click is covered too.
        var kinds = Set(limits.report.windows.map { $0.key })
        kinds.formUnion(["weekly", "session", "blocked", "compact", "away"])
        for kind in kinds { snooze(kind, hours: 4) }
        for s in limits.report.sessions {
            snooze("compact:\(s.id)", hours: 4)
            snooze("away:\(s.id)", hours: 4)
        }
        banner.hide()
    }

    @objc func toggleAwayNudge(_ sender: NSMenuItem) {
        UserDefaults.standard.set(!policy.awayNudge, forKey: "awayNudge")
        policy = LimitPolicy.load()
        if policy.awayNudge { evaluateAlerts() } else if banner.showing?.hasPrefix("away") == true { banner.hide() }
    }

    // MARK: Keeping the reading current

    /// Every figure here starts from what Claude Code last fetched, and left
    /// to itself it fetches rarely: two days old has been seen, with the week
    /// at 8% in this menu and 24% in fact. So once the scanner says the
    /// reading has aged out and tokens have been spent since, have Claude
    /// Code fetch a new one.
    func askUsageIfDue() {
        guard policy.autoCheck, limits.report.checkDue else { return }
        askUsage()
    }

    func askUsage(_ done: ((Bool, String) -> Void)? = nil) {
        // One already running: share its answer rather than start a second.
        if usageWaiters != nil {
            if let done { usageWaiters?.append(done) }
            return
        }
        usageWaiters = done.map { [$0] } ?? []
        PulseSetup.markUsageAsked()
        DispatchQueue.global(qos: .utility).async {
            let r = PulseSetup.checkUsage()
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                let waiting = self.usageWaiters ?? []
                self.usageWaiters = nil
                self.limits.refresh { [weak self] in
                    self?.limitsDone()
                    waiting.forEach { $0(r.ok, r.output) }
                }
            }
        }
    }

    @objc func toggleAutoCheck(_ sender: NSMenuItem) {
        UserDefaults.standard.set(!policy.autoCheck, forKey: "usageAutoCheck")
        policy = LimitPolicy.load()
        if policy.autoCheck { askUsageIfDue() }
    }

    @objc func checkUsageNow(_ sender: NSMenuItem) {
        askUsage { [weak self] ok, said in
            guard let self else { return }
            let a = NSAlert()
            if ok {
                let r = self.limits.report
                a.messageText = "Usage is up to date"
                a.informativeText = r.windows.map { AppDelegate.windowLine($0, ageMs: r.ageMs) }
                    .joined(separator: "\n")
            } else {
                a.alertStyle = .warning
                a.messageText = "Couldn’t get a fresh reading"
                a.informativeText = said + "\n\nTyping /usage in Claude Code does the same thing."
            }
            a.addButton(withTitle: "OK")
            NSApp.activate(ignoringOtherApps: true)
            a.runModal()
        }
    }

    /// The idle-chat reminder, with this Mac's largest live conversation in it
    /// where there is one, so the numbers being judged are real ones.
    @objc func testAwayBanner(_ sender: NSMenuItem) {
        let now = Date().timeIntervalSince1970 * 1000
        var s = limits.report.sessions.first(where: { $0.ctx >= policy.awayWarn })
            ?? SessionContext(id: "preview", project: "your-project", state: "done", ctx: 410_000,
                              model: nil, effort: nil, turnCost: 0, contextShare: 0,
                              compactedAt: 0, compactTrigger: nil, preTokens: nil, updatedAt: now,
                              reloadTimes: 11)
        s.state = "done"
        s.waitingOnUser = false
        s.repliedAt = now - 46 * 60_000
        s.cacheExpiresAt = now + 14 * 60_000
        banner.show(awaySpec(s, now: now, preview: true))
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

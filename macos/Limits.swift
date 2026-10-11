// Plan limits: how much of your Claude usage is left, and how fast it is going.
//
// The numbers come from limits-scan.js — the same script the VS Code extension
// uses — run through the bundled JavaScriptCore runner, so both halves of
// Claude Pulse agree and neither needs Node.js. The script reads the usage
// Claude Code itself caches in ~/.claude.json; nothing is fetched and nothing
// is written there.
//
// This file turns those numbers into a decision: say nothing, mention it
// quietly in the menu bar, or put a banner on the screen.

import AppKit
import Foundation

// MARK: - Model

struct LimitWindow {
    var key: String              // "session", "weekly", "weekly_opus", …
    var label: String            // "5-hour limit", "weekly limit"
    var percent: Int             // 0-100, can exceed 100 once blocked
    var resetsAt: Double = 0     // ms since epoch, 0 = unknown
    /// The server's own view. Every account seen so far reports "normal" for
    /// everything, so this is advisory: the thresholds below do the deciding.
    var severity: String? = nil
    var model: String? = nil
    var sharePercent: Double? = nil  // a per-model window's slice of the weekly budget
    var live: Double? = nil      // the cached percent carried forward to now
    var burnPerHour: Double? = nil   // percentage points per hour
    var exhaustAt: Double? = nil // ms, when this pace reaches 100%
    var headroomHours: Double? = nil // hours of slack: negative = you run dry first
    var beatsReset = false       // true = you run out before the window resets
    var calibrated = false       // false = no live estimate yet, only the cached percent
    /// How many pairs of readings the estimate rests on.
    var calibrationSamples = 0
    /// The cached reading was for a window that has since rolled over.
    var expired = false
    /// The reading is too old to describe this window any more, even though
    /// the window itself has not rolled over.
    var outdated = false
    /// False means there is no number here worth showing: the reading aged out
    /// and nothing local can stand in for it yet.
    var trusted = true

    var isWeekly: Bool { key.hasPrefix("weekly") }

    /// What to put in front of the user: the dead-reckoned figure once there
    /// is one, otherwise the cached reading.
    var shown: Int { Int((live ?? Double(percent)).rounded()) }

    /// Whether `shown` was carried forward locally rather than read from the
    /// server's own answer. Worth marking: `/usage` will say something a few
    /// points different, and a figure presented as fact that turns out to be a
    /// guess costs more trust than a figure that said so.
    var projected: Bool { live != nil }

    /// The percentage as it should be written — "78%", or "~78%" when carried
    /// forward.
    var shownText: String { (projected ? "~" : "") + "\(shown)%" }

    /// A per-model window's percentage is of that model's slice of the week,
    /// not of the week, so it reads roughly twice as high for the same spend.
    /// Anywhere the number appears alone it has to say which it is.
    var tag: String {
        if key == "session" { return "5h" }
        if key == "weekly" { return "wk" }
        if let m = model, !m.isEmpty { return String(m.prefix(4)).lowercased() }
        return key
    }
}

struct BlockedInfo {
    var kind: String             // "five_hour", "seven_day", …
    var resetsAt: Double
    var at: Double
    var noCredits: Bool
}

struct SessionContext {
    var id: String
    var project: String
    var state: String
    var ctx: Int                 // tokens the next turn will re-read
    var model: String?
    /// Claude Code's reasoning effort for this session. Its own model catalog
    /// warns that Max "can consume 3.5× or more usage than Medium".
    var effort: String?
    var turnCost: Double         // in relative units, for the share below
    var contextShare: Double     // 0-1: how much of a reply is re-reading
    /// How many replies the share was averaged over. One reply is not a basis
    /// for a sentence about every reply, so the wording depends on this.
    var turns: Int = 0
    var compactedAt: Double
    var compactTrigger: String?
    var preTokens: Int?
    var updatedAt: Double
    /// When the newest reply was written, which is what the clock below runs
    /// from. 0 = no reply measured yet.
    var repliedAt: Double = 0
    /// When this conversation stops being cheap to come back to: the server
    /// keeps it ready for a while after each reply, and past this the next
    /// message reloads all of it at full price. 0 = the transcript does not
    /// say how long, so nothing is claimed.
    var cacheExpiresAt: Double = 0
    /// How many ordinary replies that reload costs here. nil until there are
    /// enough recent replies to say what ordinary is.
    var reloadTimes: Double? = nil
    /// A question or a permission prompt that a person really has to answer —
    /// not one Claude Code approved by itself a moment later.
    var waitingOnUser = false

    /// Rounded once, here, so the banner and the menu cannot disagree about
    /// the same measurement by a point.
    var contextSharePct: Int { Int((contextShare * 100).rounded()) }

    /// Its turn is over and nothing is running: the next move is the user's.
    var finished: Bool { state == "done" || state == "idle" || state == "error" }
}

/// Claude Code's own ceiling on a conversation — its `autoCompactWindow`
/// setting, as limits-scan.js read it from ~/.claude/settings.json.
struct AutoCompactState {
    /// The top-level window. nil = Claude Code decides, which on a 1M-context
    /// model means waiting until the conversation is nearly a million tokens.
    var window: Int? = nil
    /// Models with an entry of their own, which beats the top-level one.
    /// A nil window is "auto".
    var models: [(name: String, window: Int?)] = []
    /// CLAUDE_CODE_AUTO_COMPACT_WINDOW in settings.json, which beats both.
    var env: String? = nil
    /// Auto-compact switched off altogether in Claude Code's /config.
    var off = false

    /// Models left compacting later than the top-level window asks for.
    var loose: [(name: String, window: Int?)] {
        guard let top = window else { return [] }
        return models.filter { ($0.window ?? Int.max) > top }
    }

    /// Whether every model compacts by `tokens`.
    func holds(_ tokens: Int) -> Bool { window == tokens && loose.isEmpty }
}

struct LimitReport {
    var at: Double = 0
    var available = false        // false = no usage cache (older Claude Code, logged out, API key)
    var stale = true
    var ageMs: Double?
    var plan: String?
    var windows: [LimitWindow] = []
    var blocked: BlockedInfo?
    var breakdown: [(label: String, percent: Int)] = []
    var creditsEnabled = false
    var sessions: [SessionContext] = []
    var autoCompact = AutoCompactState()
    /// The reading has aged out and something has been spent since: worth
    /// having Claude Code fetch a new one.
    var checkDue = false
    /// The last time that was tried, no new reading came back.
    var checkFailed = false

    var weekly: LimitWindow? { windows.first { $0.key == "weekly" } }
    var session: LimitWindow? { windows.first { $0.key == "session" } }

    /// The window closest to running out — what the menu bar should show.
    var worst: LimitWindow? { windows.filter { $0.trusted }.max { a, b in a.shown < b.shown } }
}

// MARK: - Reading

final class LimitReader {
    private(set) var report = LimitReport()
    /// Why the last scan produced nothing, and how many have failed in a row.
    /// A single failure is a blip — a half-written config, a transcript deleted
    /// mid-read. A run of them means the gauge has quietly stopped moving,
    /// which is worse than an error, because nothing on screen looks wrong.
    private(set) var lastError: String?
    private(set) var failures = 0
    var failing: Bool { failures >= 3 }
    private var busy = false
    private var queued: [() -> Void] = []
    private let script: String?
    private let runner: String?

    init() {
        script = Bundle.main.path(forResource: "limits-scan", ofType: "js")
        let bundled = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/pulse-hook").path
        runner = FileManager.default.isExecutableFile(atPath: bundled) ? bundled : nil
    }

    var available: Bool { script != nil && runner != nil }

    func refresh(_ done: @escaping () -> Void) {
        guard let script, let runner else { return }
        // A scan already under way may have read the files before whatever
        // prompted this call changed them, so it cannot stand in for it: run
        // once more when it finishes, however many callers asked meanwhile.
        // Capped, so a scan that never returns cannot collect callers for ever.
        guard !busy else { if queued.count < 4 { queued.append(done) }; return }
        busy = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: runner)
            p.arguments = ["run", script]
            let pipe = Pipe(), errPipe = Pipe()
            p.standardOutput = pipe
            p.standardError = errPipe
            var out = Data(), err = Data()
            var launched = false
            do {
                try p.run()
                launched = true
                out = pipe.fileHandleForReading.readDataToEndOfFile()
                err = errPipe.fileHandleForReading.readDataToEndOfFile()
                p.waitUntilExit()
            } catch { }
            let parsed = Self.parse(out)
            let why = !launched ? "could not start the scanner"
                : p.terminationStatus != 0
                    ? (String(data: err, encoding: .utf8)?
                        .split(separator: "\n").first.map(String.init) ?? "scanner exited \(p.terminationStatus)")
                    : parsed == nil ? "scanner produced nothing to read" : nil
            DispatchQueue.main.async {
                // A failed run (or a half-written config) must not wipe a good
                // reading: keep the last one until a scan actually succeeds.
                if let parsed { self?.report = parsed }
                self?.lastError = why
                if why == nil { self?.failures = 0 } else { self?.failures += 1 }
                self?.busy = false
                done()
                if let me = self, !me.queued.isEmpty {
                    let waiting = me.queued
                    me.queued = []
                    me.refresh { waiting.forEach { $0() } }
                }
            }
        }
    }

    static func parse(_ data: Data) -> LimitReport? {
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        var r = LimitReport()
        r.at = (obj["at"] as? Double) ?? 0
        r.available = (obj["available"] as? Bool) ?? false
        r.stale = (obj["stale"] as? Bool) ?? true
        r.ageMs = obj["ageMs"] as? Double
        r.plan = obj["plan"] as? String

        for w in (obj["windows"] as? [[String: Any]]) ?? [] {
            guard let key = w["key"] as? String, let pct = w["percent"] as? Double else { continue }
            let burn = w["burn"] as? [String: Any]
            r.windows.append(LimitWindow(
                key: key,
                label: (w["label"] as? String) ?? key,
                percent: Int(pct),
                resetsAt: (w["resetsAt"] as? Double) ?? 0,
                severity: w["severity"] as? String,
                model: w["model"] as? String,
                sharePercent: w["sharePercent"] as? Double,
                live: burn?["live"] as? Double,
                burnPerHour: burn?["perHour"] as? Double,
                exhaustAt: (burn?["exhaustAt"] as? Double).flatMap { $0 > 0 ? $0 : nil },
                headroomHours: burn?["headroomHours"] as? Double,
                beatsReset: (burn?["beatsReset"] as? Bool) ?? false,
                calibrated: (burn?["calibrated"] as? Bool) ?? false,
                calibrationSamples: Int((burn?["calibrationSamples"] as? Double) ?? 0),
                expired: (burn?["expired"] as? Bool) ?? false,
                outdated: (burn?["outdated"] as? Bool) ?? false,
                trusted: (burn?["trusted"] as? Bool) ?? true))
        }

        if let b = obj["blocked"] as? [String: Any] {
            r.blocked = BlockedInfo(
                kind: (b["kind"] as? String) ?? "unknown",
                resetsAt: (b["resetsAt"] as? Double) ?? 0,
                at: (b["at"] as? Double) ?? 0,
                noCredits: (b["overage"] as? String) == "rejected")
        }

        for row in (obj["breakdown"] as? [[String: Any]]) ?? [] {
            if let l = row["label"] as? String, let p = row["percent"] as? Double, p > 0 {
                r.breakdown.append((l, Int(p)))
            }
        }
        if let c = obj["credits"] as? [String: Any] { r.creditsEnabled = (c["enabled"] as? Bool) ?? false }

        for (sid, v) in (obj["sessions"] as? [String: [String: Any]]) ?? [:] {
            let turn = v["turn"] as? [String: Any]
            r.sessions.append(SessionContext(
                id: sid,
                project: (v["project"] as? String) ?? String(sid.prefix(8)),
                state: (v["state"] as? String) ?? "idle",
                ctx: Int((v["ctx"] as? Double) ?? 0),
                model: v["model"] as? String,
                effort: v["effort"] as? String,
                turnCost: (turn?["cost"] as? Double) ?? 0,
                contextShare: (turn?["contextShare"] as? Double) ?? 0,
                turns: Int((turn?["turns"] as? Double) ?? 0),
                compactedAt: (v["compactedAt"] as? Double) ?? 0,
                compactTrigger: v["compactTrigger"] as? String,
                preTokens: (v["preTokens"] as? Double).map { Int($0) },
                updatedAt: (v["updatedAt"] as? Double) ?? 0,
                repliedAt: (v["at"] as? Double) ?? 0,
                cacheExpiresAt: (v["cacheExpiresAt"] as? Double) ?? 0,
                reloadTimes: v["reloadTimes"] as? Double,
                waitingOnUser: (v["waitingConfirmed"] as? Bool) ?? false))
        }
        r.sessions.sort { $0.ctx > $1.ctx }

        if let a = obj["autoCompact"] as? [String: Any] {
            r.autoCompact.window = (a["window"] as? Double).map { Int($0) }
            // A model's entry is a number or the word "auto".
            for (name, v) in (a["models"] as? [String: Any]) ?? [:] {
                r.autoCompact.models.append((name, (v as? Double).map { Int($0) }))
            }
            r.autoCompact.models.sort { $0.name < $1.name }
            r.autoCompact.env = a["env"] as? String
            r.autoCompact.off = (a["off"] as? Bool) ?? false
        }
        if let c = obj["check"] as? [String: Any] {
            r.checkDue = (c["due"] as? Bool) ?? false
            r.checkFailed = (c["failed"] as? Bool) ?? false
        }
        return r
    }
}

// MARK: - Policy

enum LimitTier: Int, Comparable {
    case ok = 0, watch = 1, warn = 2, critical = 3, blocked = 4
    static func < (a: LimitTier, b: LimitTier) -> Bool { a.rawValue < b.rawValue }
}

/// What to show, and when. Thresholds are percentages of a window and can be
/// changed with `defaults write com.warroom.claude-pulse limitWarnWeekly -int 60`.
struct LimitPolicy {
    var watchWeekly = 50, warnWeekly = 75, criticalWeekly = 90
    var watchSession = 70, warnSession = 88, criticalSession = 96
    /// Context size at which re-reading the conversation dominates a turn.
    var contextWarn = 300_000
    var contextShareMin = 0.55
    /// Context size at which coming back to a conversation that has gone cold
    /// costs enough to be worth a word beforehand. Lower than `contextWarn`:
    /// one reload is the whole context at full price, where an ordinary reply
    /// re-reads it for a tenth.
    var awayWarn = 200_000
    /// How long before that to say so: long enough to act on, short enough
    /// that most pauses never reach it.
    var awayLeadMs: Double = 15 * 60_000
    var alertsEnabled = true
    var contextNudge = true
    var awayNudge = true
    /// Have Claude Code fetch a new usage reading when the one it holds has
    /// aged out. Every warning above is only as good as that reading.
    var autoCheck = true

    /// Where to move Claude Code's own auto-compact point. The first is the
    /// one offered by name: replayed over a real week it made the main
    /// conversations 46% cheaper, against 37% for the second, which compacts
    /// about half as often.
    static let compactPresets = [250_000, 400_000]

    static func load() -> LimitPolicy {
        var p = LimitPolicy()
        let d = UserDefaults.standard
        func int(_ key: String, _ cur: Int) -> Int {
            guard d.object(forKey: key) != nil else { return cur }
            let v = d.integer(forKey: key)
            return v > 0 && v <= 100 ? v : cur
        }
        p.watchWeekly = int("limitWatchWeekly", p.watchWeekly)
        p.warnWeekly = int("limitWarnWeekly", p.warnWeekly)
        p.criticalWeekly = int("limitCriticalWeekly", p.criticalWeekly)
        p.watchSession = int("limitWatchSession", p.watchSession)
        p.warnSession = int("limitWarnSession", p.warnSession)
        p.criticalSession = int("limitCriticalSession", p.criticalSession)
        if d.object(forKey: "contextWarnTokens") != nil {
            let v = d.integer(forKey: "contextWarnTokens")
            if v >= 20_000 { p.contextWarn = v }
        }
        if d.object(forKey: "awayWarnTokens") != nil {
            let v = d.integer(forKey: "awayWarnTokens")
            if v >= 20_000 { p.awayWarn = v }
        }
        if d.object(forKey: "limitAlerts") != nil { p.alertsEnabled = d.bool(forKey: "limitAlerts") }
        if d.object(forKey: "contextNudge") != nil { p.contextNudge = d.bool(forKey: "contextNudge") }
        if d.object(forKey: "awayNudge") != nil { p.awayNudge = d.bool(forKey: "awayNudge") }
        if d.object(forKey: "usageAutoCheck") != nil { p.autoCheck = d.bool(forKey: "usageAutoCheck") }
        return p
    }

    /// The rule that keeps the warning believable: a high percentage is only
    /// worth interrupting for if this pace actually empties the window before
    /// it refills. At 80% with twenty minutes to go there is nothing to say,
    /// and saying it anyway is how an alert gets switched off for good.
    ///
    /// Before there is enough history to project a pace, fall back to the
    /// percentage on its own — unhelpfully quiet is also a failure.
    func tier(_ w: LimitWindow) -> LimitTier {
        let (watch, warn, crit) = w.isWeekly
            ? (watchWeekly, warnWeekly, criticalWeekly)
            : (watchSession, warnSession, criticalSession)
        // An aged-out reading describes a window that no longer exists, so it
        // gets no say at all — a stale 95% would be a false alarm.
        guard w.trusted else { return .ok }
        let pct = w.shown
        var t: LimitTier = .ok

        if pct >= crit {
            t = .critical                         // nearly gone: always worth saying
        } else if w.calibrated {
            if w.beatsReset {
                if pct >= warn { t = .critical }
                else if pct >= watch { t = .warn }
                else if pct >= 30 { t = .warn }   // low, but burning dangerously fast
                else { t = .watch }
            } else if pct >= watch {
                t = .watch                        // high, yet it refills in time
            }
        } else {
            if pct >= warn { t = .warn }
            else if pct >= watch { t = .watch }
        }

        // The server can flag a window itself; never show less than it says.
        if let s = w.severity?.lowercased(), s != "normal", s != "none", s != "ok", t < .warn { t = .warn }
        return t
    }

    /// The highest tier across every window, plus which window caused it.
    func tier(_ r: LimitReport) -> (tier: LimitTier, window: LimitWindow?) {
        if r.blocked != nil { return (.blocked, r.windows.first { $0.trusted && $0.shown >= 95 } ?? r.worst) }
        var best: (LimitTier, LimitWindow?) = (.ok, nil)
        for w in r.windows {
            let t = tier(w)
            guard t >= best.0, t > .ok else { continue }
            if t > best.0 { best = (t, w); continue }
            // Ties go to the window closest to running out, so the warning
            // names the one that will actually bite. Each window's percentage
            // is of its own limit, so they do compare — but on a dead heat
            // prefer the whole-week one, which needs less explaining.
            guard let cur = best.1 else { best = (t, w); continue }
            if w.shown > cur.shown || (w.shown == cur.shown && w.model == nil && cur.model != nil) {
                best = (t, w)
            }
        }
        return best
    }

    /// Sessions big enough that re-reading the conversation is the main cost.
    func bloated(_ r: LimitReport, now: Double) -> [SessionContext] {
        guard contextNudge else { return [] }
        return r.sessions.filter {
            $0.ctx >= contextWarn && $0.contextShare >= contextShareMin
                && now - $0.updatedAt < 60 * 60_000           // still in use
                && now - $0.compactedAt > 5 * 60_000          // just compacted: give it a moment
        }
    }

    /// Large conversations left alone long enough that they are about to stop
    /// being cheap to come back to — while there is still time to do
    /// something about it. Once the moment has passed there is nothing left
    /// to say: compacting a cold conversation has to load all of it first, so
    /// it costs the reload it was meant to avoid.
    ///
    /// Only where the next move is the user's. A session still working will
    /// make its own next request whenever its tool finishes, and no reminder
    /// changes when that is.
    func goingCold(_ r: LimitReport, now: Double) -> [SessionContext] {
        guard awayNudge else { return [] }
        return r.sessions.filter {
            $0.ctx >= awayWarn && ($0.finished || $0.waitingOnUser)
                && $0.cacheExpiresAt > now && $0.cacheExpiresAt - now <= awayLeadMs
                // The short five-minute cache is inside the lead time from
                // the moment a reply lands, so this would fire after every
                // single one. There is no pause worth warning about there.
                && $0.cacheExpiresAt - $0.repliedAt >= 2 * awayLeadMs
        }
    }

    /// Whether anyone has touched this Mac lately. A reminder to act in the
    /// next fifteen minutes is no use to an empty desk — and worse than none
    /// if it is still there, long out of date, when its owner gets back.
    static func userIsHere(within seconds: Double = 240) -> Bool {
        // Every input event type at once; the constant has no Swift name.
        guard let any = CGEventType(rawValue: ~0) else { return true }
        return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: any) < seconds
    }
}

// MARK: - Words

enum LimitFmt {
    /// "2d 4h", "3h 20m", "8m" — how long until a window frees up.
    static func until(_ msAt: Double, now: Double = Date().timeIntervalSince1970 * 1000) -> String {
        let s = Int(max(0, (msAt - now) / 1000))
        if s >= 86400 { return "\(s / 86400)d \((s % 86400) / 3600)h" }
        if s >= 3600 { return "\(s / 3600)h \((s % 3600) / 60)m" }
        return "\(max(1, s / 60))m"
    }

    /// "12m", "2h 5m" — how long ago a reading was taken.
    static func ago(_ ms: Double) -> String {
        let s = Int(max(0, ms / 1000))
        if s >= 86400 { return "\(s / 86400)d" }
        if s >= 3600 { return "\(s / 3600)h \((s % 3600) / 60)m" }
        return "\(max(1, s / 60))m"
    }

    /// "today 6:20 pm", "Sun 8:30 pm" — a clock time people can act on.
    static func clock(_ msAt: Double) -> String {
        let date = Date(timeIntervalSince1970: msAt / 1000)
        let f = DateFormatter()
        f.locale = .current
        let cal = Calendar.current
        if cal.isDateInToday(date) { f.dateFormat = "h:mm a"; return "today " + f.string(from: date) }
        if cal.isDateInTomorrow(date) { f.dateFormat = "h:mm a"; return "tomorrow " + f.string(from: date) }
        f.dateFormat = "EEE h:mm a"
        return f.string(from: date)
    }

    /// "3:42 PM" — for a moment minutes away, where "today" adds nothing.
    static func time(_ msAt: Double) -> String {
        let f = DateFormatter()
        f.locale = .current
        f.dateFormat = "h:mm a"
        return f.string(from: Date(timeIntervalSince1970: msAt / 1000))
    }

    static func tokens(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.2fM", Double(n) / 1_000_000) }
        if n >= 1000 { return "\(n / 1000)k" }
        return String(n)
    }

    /// The short form for the menu bar: "wk ~82%".
    ///
    /// Always labelled. An unlabelled "80%" reads as the week, and for a
    /// per-model window that is the one reading it cannot be: those are
    /// percentages of a slice of the week, so 80% there can be 40% of the week.
    static func short(_ w: LimitWindow) -> String {
        w.tag + " " + w.shownText
    }
}

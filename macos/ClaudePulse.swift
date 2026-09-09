// Claude Pulse for macOS — a menu bar indicator for Claude Code.
//
// Reads the same state files the Claude Pulse hooks already write
// (~/.claude/claude-pulse/state/*.json), so it needs no API access, no
// network, and no configuration: install the hooks once and every Claude
// Code session on this Mac shows up here.
//
// Build: ./build.sh   (single file, swiftc, no dependencies)

import AppKit
import Foundation
import UserNotifications
import ServiceManagement

// MARK: - Model

struct Agent {
    var id: String
    var desc: String?
    var type: String
    var state: String
    var startedAt: Double?
    var lastSeen: Double?
    var endedAt: Double?
    var tools: Int
    var tool: String?
    var todosDone: Int?
    var todosTotal: Int?

    var label: String {
        let d = desc ?? "(\(type) task)"
        return d.count > 52 ? String(d.prefix(51)) + "…" : d
    }
}

struct Session {
    var id: String
    var cwd: String?
    var state: String
    var reason: String?
    var tool: String?
    var startedAt: Double?
    var endedAt: Double?
    var waitingSince: Double?
    var confirmedAt: Double?
    /// nil means the state file came from a hook older than 0.10.1 — that is
    /// "no information", not "unconfirmed"; see effectiveState().
    var waitingConfirmed: Bool?
    var hasConfirmedKey: Bool
    var updatedAt: Double
    var todosDone: Int?
    var todosTotal: Int?
    var todosActive: String?
    var agents: [Agent]

    var project: String {
        if let c = cwd, !c.isEmpty { return (c as NSString).lastPathComponent }
        return String(id.prefix(8))
    }

    var runningAgents: [Agent] {
        let now = Date().timeIntervalSince1970 * 1000
        return agents
            .filter { $0.state == "running" && now - ($0.lastSeen ?? $0.startedAt ?? 0) < 15 * 60_000 }
            .sorted { ($0.startedAt ?? 0) < ($1.startedAt ?? 0) }
    }
}

enum Display: String {
    case idle, working, waiting, done, error

    /// Lower sorts first: the most urgent session drives the menu bar.
    var rank: Int {
        switch self {
        case .waiting: return 0
        case .working: return 1
        case .error:   return 2
        case .done:    return 3
        case .idle:    return 4
        }
    }
}

// MARK: - Settings (mirrors the VS Code extension's defaults)

struct Settings {
    var doneFadeMs: Double = 15_000
    var waitTimeoutMs: Double = 45_000       // 0 => .infinity
    var provisionalMs: Double = .infinity    // 0 => never show unconfirmed waits
    var notifyOnInput: Bool = true

    static func load() -> Settings {
        var s = Settings()
        let d = UserDefaults.standard
        if d.object(forKey: "doneFadeSeconds") != nil { s.doneFadeMs = d.double(forKey: "doneFadeSeconds") * 1000 }
        if d.object(forKey: "waitTimeoutSeconds") != nil {
            let v = d.double(forKey: "waitTimeoutSeconds")
            s.waitTimeoutMs = v > 0 ? v * 1000 : .infinity
        }
        if d.object(forKey: "provisionalWaitSeconds") != nil {
            let v = d.double(forKey: "provisionalWaitSeconds")
            s.provisionalMs = v > 0 ? v * 1000 : .infinity
        }
        if d.object(forKey: "notifyOnInput") != nil { s.notifyOnInput = d.bool(forKey: "notifyOnInput") }
        return s
    }
}

// MARK: - State reading

final class StateReader {
    static let stateDir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".claude/claude-pulse/state")

    private static let workingStaleMs: Double = 60 * 60_000
    private static let staleMs: Double = 4 * 60 * 60_000

    static func read() -> [Session] {
        guard let files = try? FileManager.default.contentsOfDirectory(at: stateDir,
                                                                      includingPropertiesForKeys: nil) else { return [] }
        let now = Date().timeIntervalSince1970 * 1000
        var out: [Session] = []
        for url in files where url.pathExtension == "json" {
            guard let data = try? Data(contentsOf: url),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let state = obj["state"] as? String else { continue }   // partial write: skip
            let updated = (obj["updated_at"] as? Double) ?? 0
            let age = now - updated
            // Dead session (crashed window, killed process): ignore. The VS Code
            // extension owns cleanup; deleting here could race its atomic writes.
            if age > staleMs { continue }
            if state == "working" && age > workingStaleMs { continue }

            var agents: [Agent] = []
            if let raw = obj["agents"] as? [String: Any] {
                for (k, v) in raw {
                    guard let a = v as? [String: Any] else { continue }
                    let todos = a["todos"] as? [String: Any]
                    agents.append(Agent(
                        id: k,
                        desc: a["desc"] as? String,
                        type: (a["type"] as? String) ?? "agent",
                        state: (a["state"] as? String) ?? "running",
                        startedAt: a["started_at"] as? Double,
                        lastSeen: a["last_seen"] as? Double,
                        endedAt: a["ended_at"] as? Double,
                        tools: (a["tools"] as? Int) ?? 0,
                        tool: a["tool"] as? String,
                        todosDone: todos?["done"] as? Int,
                        todosTotal: todos?["total"] as? Int))
                }
            }
            let todos = obj["todos"] as? [String: Any]
            out.append(Session(
                id: (obj["session_id"] as? String) ?? url.deletingPathExtension().lastPathComponent,
                cwd: obj["cwd"] as? String,
                state: state,
                reason: obj["reason"] as? String,
                tool: obj["tool"] as? String,
                startedAt: obj["started_at"] as? Double,
                endedAt: obj["ended_at"] as? Double,
                waitingSince: obj["waiting_since"] as? Double,
                confirmedAt: obj["confirmed_at"] as? Double,
                waitingConfirmed: obj["waiting_confirmed"] as? Bool,
                hasConfirmedKey: obj.keys.contains("waiting_confirmed"),
                updatedAt: updated,
                todosDone: todos?["done"] as? Int,
                todosTotal: todos?["total"] as? Int,
                todosActive: todos?["active"] as? String,
                agents: agents))
        }
        return out
    }

    /// Mirrors extension.js effectiveState() exactly — see scripts/test-waiting.js.
    static func effectiveState(_ s: Session, _ now: Double, _ cfg: Settings) -> Display {
        if s.state == "done" || s.state == "error" {
            if now - (s.endedAt ?? s.updatedAt) > cfg.doneFadeMs { return .idle }
            return s.state == "error" ? .error : .done
        }
        if s.state == "waiting" {
            // No waiting_confirmed key at all = pre-0.10.1 hook: fall back to the
            // old semantics rather than silently hiding every prompt.
            let confirmed = s.hasConfirmedKey ? (s.waitingConfirmed ?? false) : true
            let age = now - (s.waitingSince ?? s.updatedAt)
            if !confirmed && age < cfg.provisionalMs { return .working }
            // The timeout exists only because approving fires no event, so it is
            // measured from the confirmation and never applied to questions.
            if s.reason != "question" && s.reason != "agent" {
                let confAge = now - (s.confirmedAt ?? s.waitingSince ?? s.updatedAt)
                if confAge > cfg.waitTimeoutMs { return .working }
            }
            return .waiting
        }
        return Display(rawValue: s.state) ?? .idle
    }
}

// MARK: - Formatting

enum Fmt {
    static func elapsed(_ ms: Double) -> String {
        let s = max(0, Int(ms / 1000))
        return "\(s / 60):" + String(format: "%02d", s % 60)
    }
    static func tokens(_ n: Double) -> String {
        if n < 1000 { return String(Int(n)) }
        if n < 1_000_000 { return String(format: n < 10_000 ? "%.1fk" : "%.0fk", n / 1000) }
        return String(format: "%.2fM", n / 1_000_000)
    }
    static func bar(done: Int, total: Int) -> String {
        guard total > 0 else { return "" }
        if total <= 12 { return String(repeating: "▰", count: done) + String(repeating: "▱", count: total - done) }
        let filled = Int((Double(done) / Double(total) * 10).rounded())
        return String(repeating: "▰", count: filled) + String(repeating: "▱", count: 10 - filled)
    }
}

// MARK: - Token usage (reuses the bundled usage-scan.js)

final class UsageScanner {
    private(set) var byDayModel: [String: [String: Double]] = [:]   // date -> model -> output tokens
    private(set) var bySession: [String: Double] = [:]              // session -> output tokens
    private var busy = false
    private let script: String?
    private let node: String?

    init() {
        script = Bundle.main.path(forResource: "usage-scan", ofType: "js")
        // GUI apps do not inherit the shell PATH, so look in the usual places.
        var found: String? = nil
        var candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        let nvm = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".nvm/versions/node")
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvm.path) {
            for v in versions.sorted().reversed() { candidates.append(nvm.appendingPathComponent("\(v)/bin/node").path) }
        }
        for c in candidates where FileManager.default.isExecutableFile(atPath: c) { found = c; break }
        node = found
    }

    var available: Bool { script != nil && node != nil }

    func refresh(_ done: @escaping () -> Void) {
        guard !busy, let script, let node else { return }
        busy = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: node)
            p.arguments = [script]
            let pipe = Pipe()
            p.standardOutput = pipe
            p.standardError = FileHandle.nullDevice
            var out = Data()
            do {
                try p.run()
                out = pipe.fileHandleForReading.readDataToEndOfFile()
                p.waitUntilExit()
            } catch { }
            var days: [String: [String: Double]] = [:]
            var sess: [String: Double] = [:]
            if let obj = (try? JSONSerialization.jsonObject(with: out)) as? [String: Any] {
                if let byDay = obj["byDay"] as? [String: [String: Any]] {
                    for (date, models) in byDay {
                        var m: [String: Double] = [:]
                        for (model, agg) in models {
                            if model == "<synthetic>" { continue }
                            if let a = agg as? [String: Any], let o = a["out"] as? Double, o > 0 { m[model] = o }
                        }
                        if !m.isEmpty { days[date] = m }
                    }
                }
                if let bs = obj["bySession"] as? [String: [String: Any]] {
                    for (sid, models) in bs {
                        var total: Double = 0
                        for (model, agg) in models where model != "<synthetic>" {
                            if let a = agg as? [String: Any], let o = a["out"] as? Double { total += o }
                        }
                        sess[sid] = total
                    }
                }
            }
            DispatchQueue.main.async {
                self?.byDayModel = days
                self?.bySession = sess
                self?.busy = false
                done()
            }
        }
    }

    private func key(_ daysAgo: Int) -> String {
        let d = Calendar.current.date(byAdding: .day, value: -daysAgo, to: Date()) ?? Date()
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }

    /// Output tokens per model over the last `days` days (today = 1).
    func sum(days: Int) -> [(model: String, out: Double)] {
        var totals: [String: Double] = [:]
        for i in 0..<days {
            for (model, out) in byDayModel[key(i)] ?? [:] { totals[model, default: 0] += out }
        }
        return totals.sorted { $0.value > $1.value }.map { (shortModel($0.key), $0.value) }
    }

    private func shortModel(_ m: String) -> String {
        var s = m.hasPrefix("claude-") ? String(m.dropFirst(7)) : m
        if let r = s.range(of: "-20[0-9]{6}$", options: .regularExpression) { s.removeSubrange(r) }
        return s
    }
}

// MARK: - App

@main
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private var dirSource: DispatchSourceFileSystemObject?
    private var dirFD: CInt = -1
    private var sessions: [Session] = []
    private var cfg = Settings.load()
    private let usage = UsageScanner()
    private var spinnerFrame = 0
    private var lastNotifiedWaiting: Set<String> = []
    private var menuOpen = false
    private var usageTick = 0
    private let buddy = DesktopBuddy()

    private let spinner = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"]

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)   // menu bar only, no Dock icon
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.font = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular)

        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu

        try? FileManager.default.createDirectory(at: StateReader.stateDir, withIntermediateDirectories: true)
        watchStateDir()

        if cfg.notifyOnInput {
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
        if usage.available { usage.refresh { [weak self] in self?.usageDone() } }

        if UserDefaults.standard.bool(forKey: "buddyVisible") { buddy.show() }

        refresh()
        // 250ms keeps the spinner alive and elapsed times honest; the work is
        // reading a handful of small files.
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(timer!, forMode: .common)
    }

    // MARK: Data

    private func tick() {
        spinnerFrame = (spinnerFrame + 1) % spinner.count
        usageTick += 1
        if usageTick % 120 == 0, usage.available { usage.refresh { [weak self] in self?.usageDone() } }
        refresh()
    }

    private func refresh() {
        cfg = Settings.load()
        sessions = StateReader.read()
        render()
        // Never rebuild the menu while it is open: removing items destroys the
        // one under the cursor (and any open submenu) before a click can land.
        // Only the text of existing rows is refreshed in place.
        if menuOpen { refreshOpenMenu() }
        if buddy.isVisible { buddy.post(buddyPayload()) }
        notifyIfNeeded()
    }

    /// The payload shape buddy.html expects (same as the VS Code extension's).
    private func buddyPayload() -> [String: Any] {
        let now = Date().timeIntervalSince1970 * 1000
        guard let (s, st) = primary() else { return ["state": "idle"] }
        var p: [String: Any] = ["state": st.rawValue, "project": s.project]
        if let r = s.reason { p["reason"] = r }
        if let t = s.tool { p["tool"] = t }
        if let started = s.startedAt { p["elapsedMs"] = now - started }
        if let started = s.startedAt, let ended = s.endedAt { p["totalMs"] = ended - started }
        if let d = s.todosDone, let t = s.todosTotal, t > 0 {
            var todos: [String: Any] = ["done": d, "total": t]
            if let a = s.todosActive { todos["active"] = a }
            p["todos"] = todos
        }
        if let out = usage.bySession[s.id], out > 0 { p["tokensSession"] = out }
        let today = usage.sum(days: 1).reduce(0) { $0 + $1.out }
        if today > 0 { p["tokensToday"] = today }
        p["agents"] = s.runningAgents.prefix(8).map { a -> [String: Any] in
            var d: [String: Any] = ["type": a.type, "tools": a.tools]
            if let desc = a.desc { d["desc"] = desc }
            if let started = a.startedAt { d["elapsedMs"] = now - started }
            return d
        }
        return p
    }

    private func watchStateDir() {
        dirFD = open(StateReader.stateDir.path, O_EVTONLY)
        guard dirFD >= 0 else { return }
        let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: dirFD,
                                                            eventMask: [.write, .delete, .rename],
                                                            queue: .main)
        src.setEventHandler { [weak self] in self?.refresh() }
        src.setCancelHandler { [weak self] in
            if let fd = self?.dirFD, fd >= 0 { close(fd) }
        }
        src.resume()
        dirSource = src
    }

    // MARK: Menu bar item

    private func primary() -> (Session, Display)? {
        let now = Date().timeIntervalSince1970 * 1000
        var best: (Session, Display)?
        for s in sessions {
            let st = StateReader.effectiveState(s, now, cfg)
            guard let b = best else { best = (s, st); continue }
            let cur = StateReader.effectiveState(b.0, now, cfg)
            if st.rank < cur.rank || (st.rank == cur.rank && s.updatedAt > b.0.updatedAt) { best = (s, st) }
        }
        return best
    }

    private func render() {
        guard let button = statusItem.button else { return }
        let now = Date().timeIntervalSince1970 * 1000
        guard let (s, st) = primary() else {
            button.attributedTitle = NSAttributedString(string: "✳", attributes: [
                .foregroundColor: NSColor.tertiaryLabelColor,
                .font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular)])
            button.toolTip = "No Claude Code session running"
            return
        }

        let busy = sessions.filter { s in
            let e = StateReader.effectiveState(s, now, cfg)
            return e == .working || e == .waiting
        }.count
        let suffix = busy > 1 ? " ×\(busy)" : ""

        var text: String
        var color = NSColor.labelColor
        switch st {
        case .waiting:
            let what = s.reason == "question" ? "question" : s.reason == "agent" ? "agent needs you" : "needs input"
            text = "🔔 \(what)\(suffix)"
            color = .systemOrange
        case .working:
            var t = "\(spinner[spinnerFrame]) "
            if let d = s.todosDone, let total = s.todosTotal, total > 0 {
                t += "\(d)/\(total) \(Fmt.bar(done: d, total: total))"
            } else if let started = s.startedAt {
                t += Fmt.elapsed(now - started)
            } else {
                t += "working"
            }
            let n = s.runningAgents.count
            if n > 0 { t += " · \(n)⚙" }
            text = t + suffix
        case .done:
            let dur = (s.startedAt != nil && s.endedAt != nil) ? " " + Fmt.elapsed(s.endedAt! - s.startedAt!) : ""
            text = "✓\(dur)\(suffix)"
            color = .systemGreen
        case .error:
            text = "⚠ error\(suffix)"
            color = .systemRed
        case .idle:
            text = "✳"
            color = .tertiaryLabelColor
        }

        button.attributedTitle = NSAttributedString(string: text, attributes: [
            .foregroundColor: color,
            .font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular)])
        button.toolTip = "\(s.project) — \(st.rawValue)"
    }

    // MARK: Dropdown

    func menuWillOpen(_ menu: NSMenu) {
        menuOpen = true
        if usage.available { usage.refresh { [weak self] in self?.usageDone() } }
        rebuild(menu)
    }
    func menuDidClose(_ menu: NSMenu) { menuOpen = false }

    /// A finished token scan updates the status bar and any open dropdown.
    private func usageDone() {
        render()
        if menuOpen { refreshOpenMenu() }
    }

    private func header(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.attributedTitle = NSAttributedString(string: title, attributes: [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
            .foregroundColor: NSColor.secondaryLabelColor])
        item.isEnabled = false
        return item
    }

    private func detail(_ title: String, indent: Int = 1) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.attributedTitle = NSAttributedString(string: title, attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular),
            .foregroundColor: NSColor.secondaryLabelColor])
        item.indentationLevel = indent
        item.isEnabled = false
        return item
    }

    /// Rows whose text carries a live timer, refreshed in place while the menu
    /// is open. `render` returns nil to leave the row as it is.
    private var liveRows: [(item: NSMenuItem, render: () -> String?, isDetail: Bool)] = []

    private func detailAttributes() -> [NSAttributedString.Key: Any] {
        [.font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular),
         .foregroundColor: NSColor.secondaryLabelColor]
    }

    private func refreshOpenMenu() {
        for row in liveRows {
            guard let text = row.render() else { continue }
            if row.isDetail {
                if row.item.attributedTitle?.string != text {
                    row.item.attributedTitle = NSAttributedString(string: text, attributes: detailAttributes())
                }
            } else if row.item.title != text {
                row.item.title = text
            }
        }
    }

    private func sessionLine(_ s: Session, _ now: Double) -> String {
        let st = StateReader.effectiveState(s, now, cfg)
        let icon = ["idle": "✳", "working": "⟳", "waiting": "🔔", "done": "✓", "error": "⚠"][st.rawValue] ?? "✳"
        var line = "\(icon)  \(s.project) — \(st.rawValue)"
        if st == .working, let started = s.startedAt { line += " \(Fmt.elapsed(now - started))" }
        return line
    }

    private func agentLine(_ a: Agent, _ now: Double) -> String {
        var l = "· \(a.type) — \(a.label)"
        if let st = a.startedAt { l += "  \(Fmt.elapsed(now - st))" }
        if let d = a.todosDone, let t = a.todosTotal, t > 0 { l += " · \(d)/\(t)" }
        else if a.tools > 0 { l += " · \(a.tools) tool\(a.tools == 1 ? "" : "s")" }
        if let tool = a.tool { l += " · \(tool)" }
        return l
    }

    private func rebuild(_ menu: NSMenu) {
        menu.removeAllItems()
        liveRows.removeAll()
        let now = Date().timeIntervalSince1970 * 1000

        if sessions.isEmpty {
            menu.addItem(header("No Claude Code sessions"))
            menu.addItem(detail("Start Claude Code and it will appear here."))
        } else {
            let ordered = sessions.sorted {
                let a = StateReader.effectiveState($0, now, cfg), b = StateReader.effectiveState($1, now, cfg)
                return a.rank != b.rank ? a.rank < b.rank : $0.updatedAt > $1.updatedAt
            }
            for s in ordered {
                let st = StateReader.effectiveState(s, now, cfg)
                let sid = s.id
                let item = NSMenuItem(title: sessionLine(s, now), action: #selector(openProject(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = s.cwd
                item.toolTip = s.cwd
                menu.addItem(item)
                liveRows.append((item, { [weak self] in
                    guard let self, let cur = self.sessions.first(where: { $0.id == sid }) else { return nil }
                    return self.sessionLine(cur, Date().timeIntervalSince1970 * 1000)
                }, false))

                if st == .working {
                    if let d = s.todosDone, let t = s.todosTotal, t > 0 {
                        var l = "\(d)/\(t) \(Fmt.bar(done: d, total: t))"
                        if let a = s.todosActive { l += "  \(a)" }
                        menu.addItem(detail(l))
                    } else if let tool = s.tool {
                        let row = detail("using \(tool)")
                        menu.addItem(row)
                        liveRows.append((row, { [weak self] in
                            guard let self, let cur = self.sessions.first(where: { $0.id == sid }),
                                  let t = cur.tool else { return nil }
                            return "using \(t)"
                        }, true))
                    }
                }
                if st == .waiting {
                    menu.addItem(detail(s.reason == "question" ? "waiting for your answer"
                                        : s.reason == "agent" ? "a subagent needs your input"
                                        : "permission prompt open" + (s.tool.map { " · \($0)" } ?? "")))
                }
                let running = s.runningAgents
                if !running.isEmpty {
                    let head = detail("\(running.count) agent\(running.count == 1 ? "" : "s") working:")
                    menu.addItem(head)
                    liveRows.append((head, { [weak self] in
                        guard let self, let cur = self.sessions.first(where: { $0.id == sid }) else { return nil }
                        let n = cur.runningAgents.count
                        return n == 0 ? "agents finished" : "\(n) agent\(n == 1 ? "" : "s") working:"
                    }, true))
                    for a in running.prefix(8) {
                        let aid = a.id
                        let row = detail(agentLine(a, now), indent: 2)
                        menu.addItem(row)
                        // Bound to the agent's identity, not its row number: when one
                        // finishes the others must not shift into its row.
                        liveRows.append((row, { [weak self] in
                            guard let self, let cur = self.sessions.first(where: { $0.id == sid }) else { return nil }
                            let now = Date().timeIntervalSince1970 * 1000
                            if let live = cur.runningAgents.first(where: { $0.id == aid }) { return self.agentLine(live, now) }
                            if let done = cur.agents.first(where: { $0.id == aid }) { return "· \(done.type) — \(done.label) · finished" }
                            return nil
                        }, true))
                    }
                    if running.count > 8 { menu.addItem(detail("…and \(running.count - 8) more", indent: 2)) }
                }
                if usage.available {
                    let tok = detail(usage.bySession[s.id].map { "\(Fmt.tokens($0)) tokens out this session" } ?? "counting tokens…")
                    menu.addItem(tok)
                    liveRows.append((tok, { [weak self] in
                        guard let self, let out = self.usage.bySession[sid] else { return nil }
                        return "\(Fmt.tokens(out)) tokens out this session"
                    }, true))
                }
                menu.addItem(NSMenuItem.separator())
            }
        }

        if usage.available {
            let todayText: () -> String? = { [weak self] in
                guard let self else { return nil }
                let t = self.usage.sum(days: 1)
                return t.isEmpty ? "today: scanning…" : "today: " + t.map { "\($0.model) \(Fmt.tokens($0.out))" }.joined(separator: " · ")
            }
            let weekText: () -> String? = { [weak self] in
                guard let self else { return nil }
                let w = self.usage.sum(days: 7)
                if w.isEmpty { return "last 7 days: scanning…" }
                let total = w.reduce(0) { $0 + $1.out }
                return "last 7 days: \(Fmt.tokens(total)) — " + w.map { $0.model }.joined(separator: ", ")
            }
            menu.addItem(header("TOKEN USAGE (output)"))
            let todayRow = detail(todayText() ?? ""), weekRow = detail(weekText() ?? "")
            menu.addItem(todayRow); liveRows.append((todayRow, todayText, true))
            menu.addItem(weekRow);  liveRows.append((weekRow, weekText, true))
            menu.addItem(detail("plan limits: run /usage inside Claude Code"))
            menu.addItem(NSMenuItem.separator())
        }

        let showBuddy = NSMenuItem(title: "Desktop Buddy", action: #selector(toggleBuddy(_:)), keyEquivalent: "")
        showBuddy.target = self
        showBuddy.state = buddy.isVisible ? .on : .off
        menu.addItem(showBuddy)

        let charItem = NSMenuItem(title: "Buddy Character", action: nil, keyEquivalent: "")
        let charMenu = NSMenu()
        let current = UserDefaults.standard.string(forKey: "buddyCharacter") ?? "critter"
        let usingImage = !(UserDefaults.standard.string(forKey: "buddyImage") ?? "").isEmpty
        let labels = ["critter": "🐹 Critter", "robot": "🤖 Robot", "cat": "🐱 Cat", "pup": "🐶 Pup",
                      "turtle": "🐢 Turtle", "snail": "🐌 Snail", "bee": "🐝 Bee",
                      "dragon": "🐉 Dragon", "ghost": "👻 Ghost"]
        for c in DesktopBuddy.characters {
            let i = NSMenuItem(title: labels[c] ?? c, action: #selector(pickCharacter(_:)), keyEquivalent: "")
            i.target = self
            i.representedObject = c
            i.state = (!usingImage && c == current) ? .on : .off
            charMenu.addItem(i)
        }
        charMenu.addItem(NSMenuItem.separator())
        let own = NSMenuItem(title: "🖼️ My own image…", action: #selector(pickImage(_:)), keyEquivalent: "")
        own.target = self
        own.state = usingImage ? .on : .off
        charMenu.addItem(own)
        charItem.submenu = charMenu
        menu.addItem(charItem)

        let sizeItem = NSMenuItem(title: "Buddy Size", action: nil, keyEquivalent: "")
        let sizeMenu = NSMenu()
        let zoom = UserDefaults.standard.object(forKey: "buddyZoom") as? Double ?? 1.0
        for (label, value) in [("Small", 0.7), ("Normal", 1.0), ("Large", 1.6), ("Huge", 2.4)] {
            let i = NSMenuItem(title: label, action: #selector(pickSize(_:)), keyEquivalent: "")
            i.target = self
            i.representedObject = value
            i.state = abs(zoom - value) < 0.01 ? .on : .off
            sizeMenu.addItem(i)
        }
        sizeItem.submenu = sizeMenu
        menu.addItem(sizeItem)

        menu.addItem(NSMenuItem.separator())

        let notify = NSMenuItem(title: "Notify when Claude needs input",
                                action: #selector(toggleNotify(_:)), keyEquivalent: "")
        notify.target = self
        notify.state = cfg.notifyOnInput ? .on : .off
        menu.addItem(notify)

        let login = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin(_:)), keyEquivalent: "")
        login.target = self
        login.state = (SMAppService.mainApp.status == .enabled) ? .on : .off
        menu.addItem(login)

        let reset = NSMenuItem(title: "Reset Session States", action: #selector(resetStates(_:)), keyEquivalent: "")
        reset.target = self
        menu.addItem(reset)

        menu.addItem(NSMenuItem.separator())
        let quit = NSMenuItem(title: "Quit Claude Pulse", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
    }

    // MARK: Actions

    @objc private func openProject(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    @objc private func toggleBuddy(_ sender: NSMenuItem) {
        buddy.toggle()
        if buddy.isVisible { buddy.post(buddyPayload()) }
    }

    @objc private func pickCharacter(_ sender: NSMenuItem) {
        guard let c = sender.representedObject as? String else { return }
        UserDefaults.standard.set(c, forKey: "buddyCharacter")
        UserDefaults.standard.set("", forKey: "buddyImage")
        buddy.reload()
        if !buddy.isVisible { buddy.show() }
        buddy.post(buddyPayload())
    }

    @objc private func pickSize(_ sender: NSMenuItem) {
        guard let z = sender.representedObject as? Double else { return }
        UserDefaults.standard.set(z, forKey: "buddyZoom")
        buddy.reload()
        if !buddy.isVisible { buddy.show() }
        buddy.post(buddyPayload())
    }

    @objc private func pickImage(_ sender: NSMenuItem) {
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.title = "Choose your buddy character image"
        panel.allowedFileTypes = ["png", "gif", "webp", "svg", "jpg", "jpeg"]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        UserDefaults.standard.set(url.path, forKey: "buddyImage")
        buddy.reload()
        if !buddy.isVisible { buddy.show() }
        buddy.post(buddyPayload())
    }

    @objc private func toggleNotify(_ sender: NSMenuItem) {
        let on = !(cfg.notifyOnInput)
        UserDefaults.standard.set(on, forKey: "notifyOnInput")
        cfg.notifyOnInput = on
        if on { UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in } }
    }

    @objc private func toggleLogin(_ sender: NSMenuItem) {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
        } catch { NSSound.beep() }
    }

    @objc private func resetStates(_ sender: NSMenuItem) {
        if let files = try? FileManager.default.contentsOfDirectory(at: StateReader.stateDir, includingPropertiesForKeys: nil) {
            for f in files where f.pathExtension == "json" { try? FileManager.default.removeItem(at: f) }
        }
        refresh()
    }

    // MARK: Notifications

    private func notifyIfNeeded() {
        guard cfg.notifyOnInput else { lastNotifiedWaiting.removeAll(); return }
        let now = Date().timeIntervalSince1970 * 1000
        var waitingNow: Set<String> = []
        for s in sessions where StateReader.effectiveState(s, now, cfg) == .waiting {
            waitingNow.insert(s.id)
            if lastNotifiedWaiting.contains(s.id) { continue }
            let c = UNMutableNotificationContent()
            c.title = "Claude needs you — \(s.project)"
            c.body = s.reason == "question" ? "Claude has a question."
                : s.reason == "agent" ? "A subagent is waiting on your input."
                : "A permission prompt is waiting."
            c.sound = .default
            let req = UNNotificationRequest(identifier: "pulse-\(s.id)-\(Int(now))", content: c, trigger: nil)
            UNUserNotificationCenter.current().add(req)
        }
        lastNotifiedWaiting = waitingNow
    }
}

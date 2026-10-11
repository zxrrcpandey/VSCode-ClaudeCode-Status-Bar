// First-run setup: connects Claude Pulse to Claude Code on any Mac.
//
// The app bundles everything it needs — hook.js, the installer scripts, the
// VS Code extension, and pulse-hook (a JavaScriptCore runner) — so a Mac with
// no Node.js and no copy of the repo can be set up with one click.

import AppKit
import Darwin

enum PulseSetup {
    static var home: URL { URL(fileURLWithPath: ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()) }
    static var claudeDir: URL { home.appendingPathComponent(".claude") }
    static var pulseDir: URL { claudeDir.appendingPathComponent("claude-pulse") }
    static var settingsFile: URL { claudeDir.appendingPathComponent("settings.json") }
    static var installedRunner: URL { pulseDir.appendingPathComponent("pulse-hook") }
    static var bundledRunner: URL { Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/pulse-hook") }
    static var resources: URL { Bundle.main.resourceURL ?? Bundle.main.bundleURL }

    static var claudeCodeFound: Bool { FileManager.default.fileExists(atPath: claudeDir.path) }

    /// Either flavour counts: `node ".../hook.js"` from the repo installer, or
    /// the native `.../pulse-hook` this app installs.
    static func hooksInstalled() -> Bool {
        guard let s = try? String(contentsOf: settingsFile, encoding: .utf8) else { return false }
        return s.contains("claude-pulse/hook.js") || s.contains("claude-pulse/pulse-hook")
    }

    /// The runner is copied to a fixed place beside hook.js and settings.json
    /// points there, so the hooks keep working if the app is moved or deleted.
    static func ensureRunner() -> String? {
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: pulseDir, withIntermediateDirectories: true)
            let tmp = pulseDir.appendingPathComponent("pulse-hook.tmp-\(getpid())")
            try? fm.removeItem(at: tmp)
            try fm.copyItem(at: bundledRunner, to: tmp)
            chmod(tmp.path, 0o755)
            // A copy taken from a downloaded app inherits its quarantine flag, and
            // macOS would then refuse to run it when Claude Code calls the hook.
            removexattr(tmp.path, "com.apple.quarantine", 0)
            // Atomic swap: a live Claude Code session may be running the hook now.
            if rename(tmp.path, installedRunner.path) != 0 {
                return "Could not place the hook runner at \(installedRunner.path): \(String(cString: strerror(errno)))"
            }
        } catch {
            return "Could not install the hook runner in \(pulseDir.path): \(error.localizedDescription)"
        }
        return nil
    }

    static func installHooks() -> (ok: Bool, output: String) {
        if let problem = ensureRunner() { return (false, problem) }
        return run(installedRunner, ["run", resources.appendingPathComponent("install-hooks.js").path], env: [
            "PULSE_HOOK_COMMAND": "\"\(installedRunner.path)\"",
            "PULSE_HOOK_SRC": resources.appendingPathComponent("hook.js").path,
        ])
    }

    // MARK: Claude Code's own status line

    static var installedLimitsScript: URL { pulseDir.appendingPathComponent("limits-scan.js") }

    /// Reads the actual setting rather than searching the file for a path.
    ///
    /// settings.json also holds `permissions.allow`, which on this machine is
    /// 368 KB of approved commands. One approval mentioning this script — easy
    /// to collect while testing the feature — made a substring search answer
    /// "installed" for ever: the menu offered only "Remove", removing found
    /// nothing to remove and reported success, and the feature could never be
    /// turned on again.
    static func statusLineInstalled() -> Bool {
        guard let data = try? Data(contentsOf: settingsFile),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let line = obj["statusLine"] as? [String: Any],
              let cmd = line["command"] as? String
        else { return false }
        return cmd.contains("claude-pulse/limits-scan.js")
            || (cmd.contains("claude-pulse") && cmd.contains("--statusline"))
    }

    /// Keep the status line's own copy of the scanner current.
    ///
    /// It runs a copy pinned at install time, which nothing refreshed — so
    /// after an upgrade two different builds of the same script read and write
    /// one limits-history.json, several times a second, with the older one
    /// quietly misreading whatever the newer one added. The extension keeps
    /// hook.js in step for the same reason; this is the other half.
    static func ensureLimitsScript() {
        guard statusLineInstalled() else { return }
        let src = resources.appendingPathComponent("limits-scan.js")
        guard let want = try? String(contentsOf: src, encoding: .utf8) else { return }
        if let have = try? String(contentsOf: installedLimitsScript, encoding: .utf8), have == want { return }
        let tmp = pulseDir.appendingPathComponent("limits-scan.js.tmp-\(getpid())")
        try? FileManager.default.createDirectory(at: pulseDir, withIntermediateDirectories: true)
        guard (try? want.write(to: tmp, atomically: false, encoding: .utf8)) != nil else { return }
        if rename(tmp.path, installedLimitsScript.path) != 0 { try? FileManager.default.removeItem(at: tmp) }
    }

    /// Usage under the Claude Code prompt. Costs nothing: the status line is
    /// terminal chrome, not part of the conversation.
    static func installStatusLine() -> (ok: Bool, output: String) {
        if let problem = ensureRunner() { return (false, problem) }
        return run(installedRunner, ["run", resources.appendingPathComponent("install-statusline.js").path], env: [
            "PULSE_STATUSLINE_COMMAND": "\"\(installedRunner.path)\" run \"\(installedLimitsScript.path)\" --statusline",
            "PULSE_LIMITS_SRC": resources.appendingPathComponent("limits-scan.js").path,
        ])
    }

    static func removeStatusLine() -> (ok: Bool, output: String) {
        let runner = FileManager.default.isExecutableFile(atPath: installedRunner.path) ? installedRunner : bundledRunner
        return run(runner, ["run", resources.appendingPathComponent("install-statusline.js").path, "--remove"], env: [:])
    }

    // MARK: Claude Code's own auto-compact point

    /// Moves the size at which Claude Code compacts a conversation by itself,
    /// or with nil puts it back to its default. This is Claude Code's own
    /// `autoCompactWindow` setting — nothing of Pulse's runs when it fires, so
    /// it goes on working with the app closed, or gone.
    static func setAutoCompact(_ tokens: Int?) -> (ok: Bool, output: String) {
        let script = resources.appendingPathComponent("set-autocompact.js").path
        return run(bundledRunner, ["run", script] + (tokens.map { ["--tokens", String($0)] } ?? ["--remove"]), env: [:])
    }

    // MARK: A fresh usage reading

    /// Every Claude Code on this Mac that could be asked, newest first. The
    /// one inside an editor's extension is usually far ahead of a `claude` on
    /// the PATH that was installed once and forgotten, and only a recent one
    /// answers /usage without a terminal — 2.1.69 replies "Unknown skill".
    static func claudeBinaries() -> [URL] {
        let fm = FileManager.default
        var found: [(version: [Int], url: URL)] = []
        for editor in [".vscode", ".vscode-insiders", ".cursor", ".windsurf"] {
            let dir = home.appendingPathComponent("\(editor)/extensions")
            for name in (try? fm.contentsOfDirectory(atPath: dir.path)) ?? []
            where name.hasPrefix("anthropic.claude-code-") {
                let exe = dir.appendingPathComponent("\(name)/resources/native-binary/claude")
                if fm.isExecutableFile(atPath: exe.path) { found.append((version(in: name), exe)) }
            }
        }
        let installed = [
            home.appendingPathComponent(".local/bin/claude").path,
            home.appendingPathComponent(".claude/local/claude").path,
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude",
        ]
        for path in installed where fm.isExecutableFile(atPath: path) {
            // Usually a link to …/versions/2.1.69, which is where the number is.
            let real = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
            found.append((version(in: real), URL(fileURLWithPath: path)))
        }
        return found.sorted { $1.version.lexicographicallyPrecedes($0.version) }.map { $0.url }
    }

    /// The last x.y.z in a path, or [0] where there is none.
    static func version(in text: String) -> [Int] {
        guard let re = try? NSRegularExpression(pattern: "(\\d+)\\.(\\d+)\\.(\\d+)"),
              let m = re.matches(in: text, range: NSRange(text.startIndex..., in: text)).last else { return [0] }
        return (1...3).compactMap { Range(m.range(at: $0), in: text).flatMap { Int(text[$0]) } }
    }

    /// When Claude Code last fetched the usage figures, by its own record.
    static func usageFetchedAt() -> Double {
        guard let data = try? Data(contentsOf: home.appendingPathComponent(".claude.json")),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let cached = obj["cachedUsageUtilization"] as? [String: Any] else { return 0 }
        return (cached["fetchedAtMs"] as? Double) ?? 0
    }

    /// Recorded before asking, where the scanner reads it — which is how
    /// every open VS Code window knows it has just been done.
    static func markUsageAsked() {
        try? FileManager.default.createDirectory(at: pulseDir, withIntermediateDirectories: true)
        let now = Int(Date().timeIntervalSince1970 * 1000)
        try? Data("{\"at\":\(now)}".utf8).write(to: pulseDir.appendingPathComponent("usage-ask.json"), options: .atomic)
    }

    /// Claude Code makes a project folder for wherever it is started, even for
    /// this: an empty one named after the temporary folder, with an empty
    /// `memory` inside. Take it away again — with rmdir, so that anything
    /// which has ever been put in there stays.
    static func tidyUsageProject() {
        let projects = claudeDir.appendingPathComponent("projects")
        for name in (try? FileManager.default.contentsOfDirectory(atPath: projects.path)) ?? []
        where name.hasSuffix("-claude-pulse-usage") {
            let dir = projects.appendingPathComponent(name)
            rmdir(dir.appendingPathComponent("memory").path)
            rmdir(dir.path)
        }
    }

    /// -p answers and exits. The rest keeps a background check from behaving
    /// like somebody opening Claude Code: no transcript, no MCP servers, and
    /// none of the user's hooks — a SessionStart hook of theirs has no
    /// business firing for this, and Pulse's own would put a phantom session
    /// in the menu.
    static let usageArguments = ["-p", "/usage", "--no-session-persistence", "--setting-sources", "project",
                                 "--strict-mcp-config", "--settings", "{\"disableAllHooks\":true}"]

    /// Has Claude Code fetch the plan usage, exactly as typing /usage does, so
    /// that the cache this app reads is current. Claude Code answers it by
    /// itself: nothing goes to a model, and it costs no tokens.
    ///
    /// Blocks for a few seconds — call it off the main thread.
    static func checkUsage() -> (ok: Bool, output: String) {
        guard let exe = claudeBinaries().first else { return (false, "Claude Code was not found on this Mac.") }
        let before = usageFetchedAt()
        // Somewhere that is nobody's project, so there are no project
        // settings, instructions or memory to pick up along the way.
        let cwd = FileManager.default.temporaryDirectory.appendingPathComponent("claude-pulse-usage")
        try? FileManager.default.createDirectory(at: cwd, withIntermediateDirectories: true)

        let p = Process()
        p.executableURL = exe
        p.arguments = usageArguments
        p.currentDirectoryURL = cwd
        var env = ProcessInfo.processInfo.environment
        // Started from inside a Claude Code session it would otherwise
        // refuse, as a nested one.
        env.removeValue(forKey: "CLAUDECODE")
        env.removeValue(forKey: "CLAUDE_CODE_ENTRYPOINT")
        env["DISABLE_AUTOUPDATER"] = "1"
        p.environment = env
        // With a pipe left open it waits three seconds for input first.
        p.standardInput = FileHandle.nullDevice
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do { try p.run() } catch {
            return (false, "Could not run \(exe.path): \(error.localizedDescription)")
        }
        // It answers in a few seconds. Anything still going after this has
        // stalled on the network, and must not hold up the next check.
        DispatchQueue.global().asyncAfter(deadline: .now() + 45) { if p.isRunning { p.terminate() } }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        tidyUsageProject()
        // The only proof that counts: the cache this app reads has moved.
        if usageFetchedAt() > before { return (true, exe.path) }
        let said = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return (false, "\(exe.path) did not fetch a new reading."
            + (said.isEmpty ? "" : "\n\n" + String(said.prefix(600))))
    }

    /// The uninstaller deletes ~/.claude/claude-pulse — including the copied
    /// runner — so it runs from the copy inside the app bundle.
    ///
    /// The status line lives in that directory too, and Claude Code would go on
    /// invoking the deleted binary on every prompt render, so it goes first.
    /// Starting at login is removed as well: a LaunchAgent in the user's own
    /// home folder would otherwise outlive the app and have launchd chasing a
    /// deleted executable at every login, with nothing left to explain it.
    static func removeHooks() -> (ok: Bool, output: String) {
        if statusLineInstalled() { _ = removeStatusLine() }
        LoginItem.set(false)
        UserDefaults.standard.set(false, forKey: "openAtLoginChosen")
        return run(bundledRunner, ["run", resources.appendingPathComponent("uninstall-hooks.js").path], env: [:])
    }

    static var bundledVSIX: URL? {
        (try? FileManager.default.contentsOfDirectory(at: resources, includingPropertiesForKeys: nil))?
            .first { $0.pathExtension == "vsix" }
    }

    static func vscodeCLI() -> String? {
        [
            "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
            home.appendingPathComponent("Applications/Visual Studio Code.app/Contents/Resources/app/bin/code").path,
            "/usr/local/bin/code",
            "/opt/homebrew/bin/code",
        ].first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    static func installVSCodeExtension() -> (ok: Bool, output: String) {
        guard let cli = vscodeCLI(), let vsix = bundledVSIX else {
            return (false, "VS Code or the bundled extension was not found.")
        }
        return run(URL(fileURLWithPath: cli), ["--install-extension", vsix.path, "--force"], env: [:])
    }

    static func run(_ exe: URL, _ args: [String], env: [String: String]) -> (ok: Bool, output: String) {
        let p = Process()
        p.executableURL = exe
        p.arguments = args
        var environment = ProcessInfo.processInfo.environment
        for (k, v) in env { environment[k] = v }
        p.environment = environment
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do { try p.run() } catch {
            return (false, "Could not run \(exe.lastPathComponent): \(error.localizedDescription)")
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus == 0, String(decoding: data, as: UTF8.self))
    }
}

// MARK: - UI

extension AppDelegate {
    /// Offered once on first launch; afterwards it lives in the menu.
    func offerSetupIfNeeded() {
        guard !PulseSetup.hooksInstalled(), !UserDefaults.standard.bool(forKey: "setupDeclined") else {
            maybeOfferLogin()
            return
        }
        let a = NSAlert()
        a.messageText = "Connect Claude Pulse to Claude Code?"
        a.informativeText = "Claude Pulse follows what Claude Code is doing through small local hooks "
            + "added to ~/.claude/settings.json. The file is backed up first, nothing leaves your Mac, "
            + "and you can remove the hooks from the menu at any time."
            + (PulseSetup.claudeCodeFound ? ""
               : "\n\nClaude Code doesn't seem to be installed yet — you can set up now, or later from the menu.")
        a.addButton(withTitle: "Set Up")
        a.addButton(withTitle: "Not Now")
        NSApp.activate(ignoringOtherApps: true)
        if a.runModal() == .alertFirstButtonReturn {
            performSetup()
        } else {
            UserDefaults.standard.set(true, forKey: "setupDeclined")
            maybeOfferLogin()
        }
    }

    /// An indicator that vanishes at the next restart is no use, so offer this
    /// once — then it lives in the menu like any other preference.
    func maybeOfferLogin() {
        let d = UserDefaults.standard
        guard d.object(forKey: "openAtLoginChosen") == nil, LoginItem.canRegister, !LoginItem.isOn else { return }
        let a = NSAlert()
        a.messageText = "Start Claude Pulse automatically?"
        a.informativeText = "It will open quietly in the menu bar when you log in, so the indicator and your "
            + "usage warnings are always there. You can turn this off in the Claude Pulse menu at any time."
        a.addButton(withTitle: "Start at Login")
        a.addButton(withTitle: "No Thanks")
        NSApp.activate(ignoringOtherApps: true)
        let yes = a.runModal() == .alertFirstButtonReturn
        d.set(yes, forKey: "openAtLoginChosen")
        guard yes else { return }
        if let message = LoginItem.set(true) { showLoginFollowUp(message) }
    }

    func showLoginFollowUp(_ message: String) {
        let a = NSAlert()
        a.messageText = "One more step"
        a.informativeText = message
        if case .needsApproval = LoginItem.state() {
            a.addButton(withTitle: "Open System Settings")
            a.addButton(withTitle: "Later")
            NSApp.activate(ignoringOtherApps: true)
            if a.runModal() == .alertFirstButtonReturn { LoginItem.openSystemSettings() }
            return
        }
        a.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        a.runModal()
    }

    func performSetup() {
        let r = PulseSetup.installHooks()
        let a = NSAlert()
        if r.ok {
            // They have just asked for Claude Pulse to be wired up, so make
            // sure it is still there after the next restart.
            var loginNote = ""
            if UserDefaults.standard.object(forKey: "openAtLoginChosen") == nil,
               LoginItem.canRegister, !LoginItem.isOn {
                UserDefaults.standard.set(true, forKey: "openAtLoginChosen")
                loginNote = LoginItem.set(true).map { "\n\n" + $0 }
                    ?? "\n\nIt will start automatically when you log in — you can turn that off in the menu."
            }
            let canVS = PulseSetup.vscodeCLI() != nil && PulseSetup.bundledVSIX != nil
            a.messageText = "Claude Pulse is connected"
            a.informativeText = "Start a new Claude Code session (or restart the one you have open) and it will appear in the menu bar."
                + loginNote
            if canVS {
                a.informativeText += "\n\nVS Code is installed — add the Claude Pulse status bar extension as well?"
                a.addButton(withTitle: "Install VS Code Extension")
                a.addButton(withTitle: "Done")
            } else {
                a.addButton(withTitle: "Done")
            }
            NSApp.activate(ignoringOtherApps: true)
            if a.runModal() == .alertFirstButtonReturn, canVS { performVSCodeInstall() }
        } else {
            a.alertStyle = .warning
            a.messageText = "Setup didn't finish"
            a.informativeText = String(r.output.suffix(1500))
            a.addButton(withTitle: "OK")
            NSApp.activate(ignoringOtherApps: true)
            a.runModal()
        }
    }

    func performVSCodeInstall() {
        let r = PulseSetup.installVSCodeExtension()
        let a = NSAlert()
        a.messageText = r.ok ? "VS Code extension installed" : "Couldn't install the VS Code extension"
        a.informativeText = r.ok ? "Restart VS Code to load it." : String(r.output.suffix(1500))
        if !r.ok { a.alertStyle = .warning }
        a.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        a.runModal()
    }

    @objc func setupHooksMenu(_ sender: NSMenuItem) {
        UserDefaults.standard.removeObject(forKey: "setupDeclined")
        performSetup()
    }

    @objc func removeHooksMenu(_ sender: NSMenuItem) {
        let c = NSAlert()
        c.messageText = "Remove Claude Pulse hooks?"
        c.informativeText = "Claude Code will stop reporting to Claude Pulse. ~/.claude/settings.json is backed up first, and your other hooks and settings are left alone."
        c.addButton(withTitle: "Remove")
        c.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard c.runModal() == .alertFirstButtonReturn else { return }
        let r = PulseSetup.removeHooks()
        let a = NSAlert()
        a.messageText = r.ok ? "Hooks removed" : "Couldn't remove the hooks"
        a.informativeText = r.ok ? "Choose “Set Up Claude Code Hooks…” in the menu to reconnect." : String(r.output.suffix(1500))
        if !r.ok { a.alertStyle = .warning }
        a.addButton(withTitle: "OK")
        a.runModal()
    }

    @objc func installVSCodeMenu(_ sender: NSMenuItem) { performVSCodeInstall() }

    // MARK: Compact Chats Automatically

    /// A choice rather than a switch, because there is more than one "on" and
    /// the state can be one this app did not create: `/autocompact` inside
    /// Claude Code edits the same setting, per model. Whatever is in force is
    /// the row that carries the tick.
    func autoCompactMenuItem() -> NSMenuItem {
        let ac = limits.report.autoCompact
        let item = NSMenuItem(title: "Compact Chats Automatically", action: nil, keyEquivalent: "")
        if let env = ac.env {
            // Claude Code uses the variable instead of the setting, so nothing
            // chosen here could take effect. A dead row that says why beats
            // three live ones that silently do nothing.
            item.title = "Compact Chats Automatically — fixed by an environment variable"
            item.toolTip = "CLAUDE_CODE_AUTO_COMPACT_WINDOW is set to \(env) in ~/.claude/settings.json, "
                + "and Claude Code uses that instead of this setting."
            return item
        }
        if let w = ac.window { item.title += " — at \(LimitFmt.tokens(w))" }

        let sub = NSMenu()
        func row(_ title: String, _ tokens: Int, _ state: NSControl.StateValue) {
            let i = NSMenuItem(title: title, action: #selector(pickAutoCompact(_:)), keyEquivalent: "")
            i.target = self
            i.representedObject = tokens
            i.state = state
            sub.addItem(i)
        }
        // On for a size only when no model is left compacting later than it.
        func state(_ tokens: Int) -> NSControl.StateValue {
            ac.window != tokens ? .off : ac.loose.isEmpty ? .on : .mixed
        }
        row("Claude Code’s Default — waits until the model is full", 0, ac.window == nil ? .on : .off)
        for (n, tokens) in LimitPolicy.compactPresets.enumerated() {
            row("At \(LimitFmt.tokens(tokens)) — " + (n == 0 ? "recommended" : "compacts less often"),
                tokens, state(tokens))
        }
        if let w = ac.window, !LimitPolicy.compactPresets.contains(w) {
            row("At \(LimitFmt.tokens(w)) — set in Claude Code", w, state(w))
        }

        // Entries of their own beat the choice above, so they are shown.
        let own = ac.models.filter { $0.window != ac.window }
        if !own.isEmpty || ac.off { sub.addItem(NSMenuItem.separator()) }
        for m in own.prefix(5) {
            let name = m.name.hasPrefix("claude-") ? String(m.name.dropFirst(7)) : m.name
            sub.addItem(detail("\(name) has its own setting: \(m.window.map { LimitFmt.tokens($0) } ?? "auto")"))
        }
        if !ac.loose.isEmpty {
            sub.addItem(detail("choose a size again to bring \(ac.loose.count == 1 ? "it" : "them") in line"))
        }
        if ac.off {
            sub.addItem(detail("⚠ auto-compact is switched off in Claude Code — turn it on in /config"))
        }
        item.submenu = sub
        return item
    }

    @objc func pickAutoCompact(_ sender: NSMenuItem) {
        let chosen = (sender.representedObject as? Int) ?? 0
        let ac = limits.report.autoCompact
        // The row that is already in force: nothing to change, nothing to say.
        if chosen == 0 ? ac.window == nil : ac.holds(chosen) { return }
        applyAutoCompact(chosen == 0 ? nil : chosen)
    }

    /// nil puts it back to Claude Code's default.
    func applyAutoCompact(_ tokens: Int?) {
        let r = PulseSetup.setAutoCompact(tokens)
        // The script's own asides — a model that had a setting of its own,
        // auto-compact being switched off — belong in front of the user. Its
        // routine lines are already said better below.
        let asides = r.output.split(separator: "\n").map(String.init).filter {
            $0.hasPrefix("Note:") || $0.contains("had its own setting") || $0.hasPrefix("Put back")
        }
        let a = NSAlert()
        if r.ok, let tokens {
            a.messageText = "Claude Code will compact at \(LimitFmt.tokens(tokens))"
            a.informativeText = "A conversation is now summarised automatically once it reaches "
                + "\(LimitFmt.tokens(tokens)) tokens, instead of when the model is full. Every reply "
                + "after that re-reads far less.\n\n"
                + "It forgets detail a little sooner, so Claude may re-read a file now and then. If that "
                + "gets in the way, choose a larger size from the same menu.\n\n"
                + "Conversations already open pick it up when they are next started — restart Claude Code "
                + "to be sure. ~/.claude/settings.json was backed up first."
        } else if r.ok {
            a.messageText = "Back to Claude Code’s default"
            a.informativeText = "Claude Code decides when to compact again — on most models, "
                + "only once the conversation has filled the model."
        } else {
            a.alertStyle = .warning
            a.messageText = "Couldn't change the auto-compact setting"
            a.informativeText = String(r.output.suffix(1500))
        }
        if r.ok, !asides.isEmpty { a.informativeText += "\n\n" + asides.joined(separator: "\n") }
        a.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        a.runModal()
        // The menu reads this from the last scan, so take a new one now
        // rather than show the old choice ticked for the next minute.
        limits.refresh { [weak self] in self?.limitsDone() }
    }

    @objc func toggleStatusLine(_ sender: NSMenuItem) {
        let adding = !PulseSetup.statusLineInstalled()
        if adding {
            let c = NSAlert()
            c.messageText = "Show your usage inside Claude Code?"
            c.informativeText = "This adds a status line under the Claude Code prompt showing how much of your "
                + "5-hour and weekly limits is left, and when a conversation has grown expensive. It is part of "
                + "the terminal display, not the conversation, so it costs no tokens.\n\n"
                + "~/.claude/settings.json is backed up first."
            c.addButton(withTitle: "Add It")
            c.addButton(withTitle: "Cancel")
            NSApp.activate(ignoringOtherApps: true)
            guard c.runModal() == .alertFirstButtonReturn else { return }
        }
        let r = adding ? PulseSetup.installStatusLine() : PulseSetup.removeStatusLine()
        let a = NSAlert()
        if r.ok {
            a.messageText = adding ? "Added to Claude Code" : "Removed"
            a.informativeText = adding
                ? "Restart Claude Code (or open a new session) and your usage appears under the prompt."
                : "Claude Code's status line is back to how it was."
        } else {
            a.alertStyle = .warning
            a.messageText = adding ? "Couldn't add the status line" : "Couldn't remove the status line"
            a.informativeText = String(r.output.suffix(1500))
        }
        a.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        a.runModal()
    }
}

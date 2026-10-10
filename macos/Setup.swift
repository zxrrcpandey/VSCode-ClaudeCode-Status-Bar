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

    static func statusLineInstalled() -> Bool {
        guard let s = try? String(contentsOf: settingsFile, encoding: .utf8) else { return false }
        return s.contains("claude-pulse/limits-scan.js")
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

    /// The uninstaller deletes ~/.claude/claude-pulse — including the copied
    /// runner — so it runs from the copy inside the app bundle.
    static func removeHooks() -> (ok: Bool, output: String) {
        run(bundledRunner, ["run", resources.appendingPathComponent("uninstall-hooks.js").path], env: [:])
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

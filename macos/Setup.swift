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
    static func installHooks() -> (ok: Bool, output: String) {
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
                return (false, "Could not place the hook runner at \(installedRunner.path): \(String(cString: strerror(errno)))")
            }
        } catch {
            return (false, "Could not install the hook runner in \(pulseDir.path): \(error.localizedDescription)")
        }
        return run(installedRunner, ["run", resources.appendingPathComponent("install-hooks.js").path], env: [
            "PULSE_HOOK_COMMAND": "\"\(installedRunner.path)\"",
            "PULSE_HOOK_SRC": resources.appendingPathComponent("hook.js").path,
        ])
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
        guard !PulseSetup.hooksInstalled(), !UserDefaults.standard.bool(forKey: "setupDeclined") else { return }
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
        }
    }

    func performSetup() {
        let r = PulseSetup.installHooks()
        let a = NSAlert()
        if r.ok {
            let canVS = PulseSetup.vscodeCLI() != nil && PulseSetup.bundledVSIX != nil
            a.messageText = "Claude Pulse is connected"
            a.informativeText = "Start a new Claude Code session (or restart the one you have open) and it will appear in the menu bar."
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
}

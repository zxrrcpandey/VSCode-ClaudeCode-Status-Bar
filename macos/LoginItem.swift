// Starting with the Mac.
//
// A menu bar indicator that does not come back after a restart is not much of
// an indicator, so Claude Pulse registers itself as a login item the first
// time it is set up.
//
// Two mechanisms, because the modern one can refuse. SMAppService (macOS 13+)
// is the right API: it puts a real entry in System Settings › General ›
// Login Items that the user can see and revoke. It can come back as
// "requiresApproval" though, and for a build signed ad-hoc rather than with a
// Developer ID it can fail outright — so there is a plain LaunchAgent as a
// fallback, which is just a plist in the user's own home directory.
//
// Only ever one of the two is active at a time: both would launch the app
// twice and leave two icons in the menu bar.

import AppKit
import ServiceManagement

enum LoginItem {

    enum State {
        case on                 // will start at login
        case off
        case needsApproval      // registered, but the user must allow it in System Settings
        case unavailable(String) // cannot be set up from where the app is running
    }

    static let label = "com.warroom.claude-pulse"

    private static var plistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }

    private static var executable: String {
        Bundle.main.executableURL?.path
            ?? Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/ClaudePulse").path
    }

    /// A login item has to point at a stable location. Running from a build
    /// folder or the mounted disk image, it would point at a path that will not
    /// be there next time.
    static var canRegister: Bool {
        let p = Bundle.main.bundleURL.path
        return p.hasPrefix("/Applications/") || p.hasPrefix(NSHomeDirectory() + "/Applications/")
    }

    /// Whether there is a plist on disk at all — enough to know there is
    /// something to remove, but not that it would work.
    private static var agentPresent: Bool {
        FileManager.default.fileExists(atPath: plistURL.path)
    }

    /// A *usable* agent: one that points at an executable that still exists.
    ///
    /// The path is baked in when the agent is written, so renaming the app,
    /// moving it, or installing a build under a different bundle name strands
    /// it — launchd then fails to spawn it at every login. Reporting that as
    /// "on" would be bad enough on its own; it also disables the one repair
    /// path there is, because the launch-time self-heal only runs when the
    /// login item is off.
    private static var agentInstalled: Bool {
        guard let data = try? Data(contentsOf: plistURL),
              let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil),
              let dict = plist as? [String: Any],
              let args = dict["ProgramArguments"] as? [String],
              let first = args.first
        else { return false }
        return first == executable && FileManager.default.isExecutableFile(atPath: first)
    }

    // MARK: Status

    static func state() -> State {
        if agentInstalled { return .on }
        switch SMAppService.mainApp.status {
        case .enabled: return .on
        case .requiresApproval: return .needsApproval
        case .notFound:
            return canRegister ? .off : .unavailable("Move Claude Pulse to your Applications folder first.")
        default:
            return canRegister ? .off : .unavailable("Move Claude Pulse to your Applications folder first.")
        }
    }

    static var isOn: Bool {
        switch state() { case .on, .needsApproval: return true; default: return false }
    }

    // MARK: Changing it

    /// Returns a message worth showing the user, or nil when it just worked.
    @discardableResult
    static func set(_ on: Bool) -> String? {
        if !on {
            removeAgent()
            if SMAppService.mainApp.status == .enabled || SMAppService.mainApp.status == .requiresApproval {
                do { try SMAppService.mainApp.unregister() } catch {
                    return "Could not remove the login item: \(error.localizedDescription)"
                }
            }
            return nil
        }

        guard canRegister else {
            return "Claude Pulse can only start at login from your Applications folder. "
                + "Drag it there, open it from there, and try again."
        }

        // Preferred: a real login item the user can see and switch off.
        do {
            if SMAppService.mainApp.status != .enabled { try SMAppService.mainApp.register() }
            removeAgent()                       // never both
            if SMAppService.mainApp.status == .requiresApproval {
                return "Claude Pulse is added, but macOS wants you to allow it: "
                    + "System Settings › General › Login Items › Allow in the Background."
            }
            return nil
        } catch {
            // Fall back to a LaunchAgent. This is the path an ad-hoc signed
            // build tends to take, and it works without any approval dialog.
            if installAgent() { return nil }
            return "Could not set Claude Pulse to start at login: \(error.localizedDescription)"
        }
    }

    static func openSystemSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }

    // MARK: LaunchAgent fallback

    private static func installAgent() -> Bool {
        let plist: [String: Any] = [
            "Label": label,
            "ProgramArguments": [executable],
            "RunAtLoad": true,
            // Only in a real logged-in desktop session, not over ssh.
            "LimitLoadToSessionType": "Aqua",
            "ProcessType": "Interactive",
            // Deliberately NOT KeepAlive: quitting from the menu should stay quit.
        ]
        do {
            try FileManager.default.createDirectory(at: plistURL.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            try data.write(to: plistURL, options: .atomic)
        } catch { return false }
        // Load it now so it takes effect without a logout. Whether that
        // succeeds is not what decides the outcome: launchd reads
        // ~/Library/LaunchAgents at every login regardless, so once the plist
        // is written the login item is installed. Returning the bootstrap's
        // exit status instead produced an error dialog next to a ticked
        // checkbox — and the obvious response, clicking it again, meant "off".
        if ProcessInfo.processInfo.environment["XPC_SERVICE_NAME"] != label {
            launchctl(["bootout", "gui/\(getuid())/\(label)"])
        }
        launchctl(["bootstrap", "gui/\(getuid())", plistURL.path])
        return true
    }

    /// Order matters, and so does not booting out our own job.
    ///
    /// `launchctl bootout` does not merely unload a job, it terminates it. When
    /// the app was started at login by this very agent, the running app *is*
    /// that job — so booting it out sends this process a SIGTERM. There is no
    /// handler, so it dies immediately, before the line that deletes the plist:
    /// the menu bar icon vanishes mid-click and the agent is still there at the
    /// next login, with the box the user just unticked showing as on.
    ///
    /// Deleting the plist first is what makes "off" stick. An already-loaded
    /// job simply goes when the app quits or the user logs out.
    private static func removeAgent() {
        guard agentPresent else { return }
        try? FileManager.default.removeItem(at: plistURL)
        // launchd sets this to the job label for jobs it starts, and to
        // application.<bundle-id>.<n>.<n> for a LaunchServices launch.
        guard ProcessInfo.processInfo.environment["XPC_SERVICE_NAME"] != label else { return }
        launchctl(["bootout", "gui/\(getuid())/\(label)"])
    }

    @discardableResult
    private static func launchctl(_ args: [String]) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
    }

    // MARK: One copy only

    /// Held for the lifetime of the process. The kernel releases it when the
    /// process ends, however it ends, so a crash cannot leave it stuck.
    private static var lockFD: Int32 = -1

    /// Takes an exclusive lock, returning false if another copy already holds
    /// it and this one should stand down.
    ///
    /// A LaunchAgent starts the executable directly, which bypasses the check
    /// LaunchServices would normally do — so opening the app from Finder while
    /// one is already running would put two icons in the menu bar, two 0.25s
    /// timers, and two writers on limits-history.json.
    ///
    /// A lock rather than a comparison of process ids. Pids wrap at 99999, so
    /// on a long-running Mac the older instance can hold the *higher* pid and
    /// "older" stops meaning "lower"; and a pid comparison has to wait for
    /// LaunchServices registration, which has not happened yet at the moment
    /// two simultaneous launches would need to resolve. A lock is atomic and
    /// needs neither.
    static func claimSingleInstance() -> Bool {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".claude/claude-pulse")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let fd = open(dir.appendingPathComponent("app.lock").path, O_CREAT | O_WRONLY, 0o644)
        // Nowhere to put the lock: better to run than to refuse to start.
        guard fd >= 0 else { return true }
        if flock(fd, LOCK_EX | LOCK_NB) != 0 {
            close(fd)
            return false
        }
        lockFD = fd
        return true
    }
}

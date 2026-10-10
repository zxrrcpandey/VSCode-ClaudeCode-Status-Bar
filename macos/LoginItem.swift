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

    private static var agentInstalled: Bool {
        FileManager.default.fileExists(atPath: plistURL.path)
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
        // Load it now so it is registered before the next login, ignoring the
        // "already bootstrapped" case.
        launchctl(["bootout", "gui/\(getuid())/\(label)"])
        return launchctl(["bootstrap", "gui/\(getuid())", plistURL.path])
    }

    private static func removeAgent() {
        guard agentInstalled else { return }
        launchctl(["bootout", "gui/\(getuid())/\(label)"])
        try? FileManager.default.removeItem(at: plistURL)
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

    /// A LaunchAgent starts the executable directly, which bypasses the check
    /// LaunchServices would normally do — so opening the app from Finder while
    /// one is already running would put two icons in the menu bar.
    ///
    /// Compares process ids rather than just counting, so if two copies ever
    /// do start at the same moment exactly one of them stands down.
    static func anotherOlderInstanceIsRunning() -> Bool {
        guard let id = Bundle.main.bundleIdentifier else { return false }
        let me = ProcessInfo.processInfo.processIdentifier
        return NSRunningApplication.runningApplications(withBundleIdentifier: id)
            .contains { $0.processIdentifier != me && !$0.isTerminated && $0.processIdentifier < me }
    }
}

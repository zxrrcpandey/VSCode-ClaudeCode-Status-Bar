// pulse-hook — runs Claude Pulse's JavaScript on JavaScriptCore, which ships
// with every Mac, so the hooks work on a Mac that has no Node.js.
//
// It provides only the slice of Node's API that hook.js, install-hooks.js,
// uninstall-hooks.js and usage-scan.js actually use (fs, path, os, process,
// console). Those scripts stay the single, tested implementation whether they
// run under Node (VS Code extension, repo) or here (macOS app). To prove the
// two agree:  PULSE_HOOK_BIN=<this binary> node scripts/test-waiting.js
//
//   pulse-hook               run hook.js beside this binary (event JSON on stdin)
//   pulse-hook run <script>  run any script: installer, uninstaller, usage scanner

import Foundation
import JavaScriptCore
import Darwin

@main
struct PulseHook {
    static func main() {
        let argv = CommandLine.arguments
        let runMode = argv.count >= 3 && argv[1] == "run"
        let script: String
        if runMode {
            script = URL(fileURLWithPath: argv[2]).standardizedFileURL.path
        } else {
            let exe = (Bundle.main.executableURL ?? URL(fileURLWithPath: argv[0])).resolvingSymlinksInPath()
            script = exe.deletingLastPathComponent().appendingPathComponent("hook.js").path
        }

        // As a hook it must never fail loudly or print: Claude Code adds some
        // hooks' stdout to the conversation and reports non-zero exits as errors.
        func bail(_ message: String) -> Never {
            if runMode {
                FileHandle.standardError.write(Data("pulse-hook: \(message)\n".utf8))
                exit(1)
            }
            exit(0)
        }

        guard var source = try? String(contentsOfFile: script, encoding: .utf8) else { bail("cannot read \(script)") }
        guard let ctx = JSContext() else { bail("JavaScriptCore is unavailable") }
        if source.hasPrefix("#!") { source = "//" + source.dropFirst(2) }   // shebang is not JavaScript

        var uncaught: String?
        ctx.exceptionHandler = { _, exc in
            guard let exc else { return }
            var text = exc.toString() ?? "error"
            if let stack = exc.objectForKeyedSubscript("stack"), !stack.isUndefined, let s = stack.toString() {
                text += "\n" + s
            }
            uncaught = text
        }

        NodeShim.install(ctx, script: script, extraArgs: Array(argv.dropFirst(runMode ? 3 : 1)))
        ctx.evaluateScript(source, withSourceURL: URL(fileURLWithPath: script))

        if let uncaught { bail(uncaught) }
        exit(0)
    }
}

// MARK: - The Node API subset

enum NodeShim {
    typealias Impl = ([JSValue]) -> JSValue

    /// Wrap a Swift closure as a JavaScript function. It must be bridged as an
    /// Objective-C block object (unsafeBitCast), or JSC sees an opaque value.
    static func fn(_ impl: @escaping Impl) -> AnyObject {
        let block: @convention(block) () -> JSValue = {
            impl((JSContext.currentArguments() as? [JSValue]) ?? [])
        }
        return unsafeBitCast(block, to: AnyObject.self)
    }

    static func fnBool(_ impl: @escaping () -> Bool) -> AnyObject {
        let block: @convention(block) () -> Bool = { impl() }
        return unsafeBitCast(block, to: AnyObject.self)
    }

    static var ctx: JSContext { JSContext.current() }
    static func undefined() -> JSValue { JSValue(undefinedIn: ctx) }
    static func value(_ any: Any) -> JSValue { JSValue(object: any, in: ctx) }

    static func string(_ a: [JSValue], _ i: Int) -> String { i < a.count ? (a[i].toString() ?? "") : "" }
    static func number(_ a: [JSValue], _ i: Int) -> Double { i < a.count ? a[i].toDouble() : 0 }
    static func option(_ a: [JSValue], _ i: Int, _ key: String) -> Bool {
        guard i < a.count, a[i].isObject, let v = a[i].objectForKeyedSubscript(key) else { return false }
        return v.toBool()
    }

    /// Throw a Node-style error (with `.code`) into the calling script — the
    /// hook's lock loop, for one, branches on `e.code === 'EEXIST'`.
    static func fail(_ message: String, _ code: String) -> JSValue {
        let c = ctx
        if let err = JSValue(newErrorFromMessage: message, in: c) {
            err.setValue(code, forProperty: "code")
            c.exception = err
        }
        return JSValue(undefinedIn: c)
    }

    static func errnoCode(_ e: Int32) -> String {
        switch e {
        case EEXIST: return "EEXIST"
        case ENOENT: return "ENOENT"
        case EACCES: return "EACCES"
        case EPERM: return "EPERM"
        case ENOTDIR: return "ENOTDIR"
        case EISDIR: return "EISDIR"
        case ENOTEMPTY: return "ENOTEMPTY"
        default: return "E\(e)"
        }
    }

    static func failErrno(_ op: String, _ path: String) -> JSValue {
        let e = errno
        let code = errnoCode(e)
        return fail("\(code): \(String(cString: strerror(e))), \(op) '\(path)'", code)
    }

    static func writeAll(_ fd: Int32, _ data: Data) -> Bool {
        if data.isEmpty { return true }
        return data.withUnsafeBytes { buf -> Bool in
            guard let base = buf.baseAddress else { return true }
            var off = 0
            while off < buf.count {
                let n = Darwin.write(fd, base + off, buf.count - off)
                if n <= 0 { return false }
                off += n
            }
            return true
        }
    }

    static func mkdirs(_ p: String) -> Bool {
        var built = p.hasPrefix("/") ? "" : "."
        for part in p.split(separator: "/") {
            built += "/" + part
            if mkdir(built, 0o755) != 0 && errno != EEXIST { return false }
        }
        return true
    }

    static func normalize(_ p: String) -> String {
        if p.isEmpty { return "." }
        let absolute = p.hasPrefix("/")
        var out: [Substring] = []
        for seg in p.split(separator: "/") {
            if seg == "." { continue }
            if seg == ".." {
                if let last = out.last, last != ".." { out.removeLast() } else if !absolute { out.append(seg) }
                continue
            }
            out.append(seg)
        }
        let body = out.joined(separator: "/")
        return absolute ? "/" + body : (body.isEmpty ? "." : body)
    }

    static func dirname(_ p: String) -> String {
        var s = p
        while s.count > 1 && s.hasSuffix("/") { s.removeLast() }
        guard let idx = s.lastIndex(of: "/") else { return "." }
        if idx == s.startIndex { return "/" }
        return String(s[s.startIndex..<idx])
    }

    static func install(_ context: JSContext, script: String, extraArgs: [String]) {
        let fs = JSValue(newObjectIn: context)!
        let path = JSValue(newObjectIn: context)!
        let os = JSValue(newObjectIn: context)!
        let process = JSValue(newObjectIn: context)!
        let console = JSValue(newObjectIn: context)!
        let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()

        // MARK: fs

        fs.setValue(fn { a in
            guard let first = a.first else { return fail("EINVAL: path is required", "EINVAL") }
            if first.isNumber {                                      // readFileSync(0): stdin
                let h = FileHandle(fileDescriptor: first.toInt32(), closeOnDealloc: false)
                let data = ((try? h.readToEnd()) ?? nil) ?? Data()
                return value(String(decoding: data, as: UTF8.self))
            }
            let p = string(a, 0)
            let fd = open(p, O_RDONLY)
            if fd < 0 { return failErrno("open", p) }
            let h = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            do {
                let data = try h.readToEnd() ?? Data()
                return value(String(decoding: data, as: UTF8.self))
            } catch {
                return fail("EISDIR: illegal operation on a directory, read '\(p)'", "EISDIR")
            }
        }, forProperty: "readFileSync")

        fs.setValue(fn { a in
            let p = string(a, 0)
            let fd = open(p, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
            if fd < 0 { return failErrno("open", p) }
            defer { close(fd) }
            if !writeAll(fd, Data(string(a, 1).utf8)) { return failErrno("write", p) }
            return undefined()
        }, forProperty: "writeFileSync")

        fs.setValue(fn { a in
            let p = string(a, 0)
            let fd = open(p, O_WRONLY | O_CREAT | O_APPEND, 0o644)
            if fd < 0 { return failErrno("open", p) }
            defer { close(fd) }
            if !writeAll(fd, Data(string(a, 1).utf8)) { return failErrno("write", p) }
            return undefined()
        }, forProperty: "appendFileSync")

        fs.setValue(fn { a in
            let from = string(a, 0), to = string(a, 1)
            return rename(from, to) == 0 ? undefined() : failErrno("rename", from)
        }, forProperty: "renameSync")

        fs.setValue(fn { a in
            let p = string(a, 0)
            return unlink(p) == 0 ? undefined() : failErrno("unlink", p)
        }, forProperty: "unlinkSync")

        fs.setValue(fn { a in
            let p = string(a, 0)
            if option(a, 1, "recursive") { return mkdirs(p) ? undefined() : failErrno("mkdir", p) }
            return mkdir(p, 0o755) == 0 ? undefined() : failErrno("mkdir", p)
        }, forProperty: "mkdirSync")

        fs.setValue(fn { a in value(access(string(a, 0), F_OK) == 0) }, forProperty: "existsSync")

        fs.setValue(fn { a in
            let p = string(a, 0)
            var st = stat()
            if stat(p, &st) != 0 { return failErrno("stat", p) }
            let o = JSValue(newObjectIn: ctx)!
            o.setValue(Double(st.st_mtimespec.tv_sec) * 1000 + Double(st.st_mtimespec.tv_nsec) / 1_000_000, forProperty: "mtimeMs")
            o.setValue(Double(st.st_size), forProperty: "size")
            let kind = st.st_mode & S_IFMT
            o.setValue(fnBool { kind == S_IFREG }, forProperty: "isFile")
            o.setValue(fnBool { kind == S_IFDIR }, forProperty: "isDirectory")
            return o
        }, forProperty: "statSync")

        fs.setValue(fn { a in
            let p = string(a, 0)
            let flags: Int32
            switch a.count > 1 ? string(a, 1) : "r" {
            case "wx": flags = O_WRONLY | O_CREAT | O_EXCL       // the hook's lock file
            case "w": flags = O_WRONLY | O_CREAT | O_TRUNC
            case "a": flags = O_WRONLY | O_CREAT | O_APPEND
            default: flags = O_RDONLY
            }
            let fd = open(p, flags, 0o644)
            return fd < 0 ? failErrno("open", p) : value(Int(fd))
        }, forProperty: "openSync")

        fs.setValue(fn { a in
            close(Int32(number(a, 0)))
            return undefined()
        }, forProperty: "closeSync")

        fs.setValue(fn { a in
            let from = string(a, 0), to = string(a, 1)
            return copyfile(from, to, nil, copyfile_flags_t(COPYFILE_DATA)) == 0 ? undefined() : failErrno("copyfile", from)
        }, forProperty: "copyFileSync")

        fs.setValue(fn { a in
            let p = string(a, 0)
            if access(p, F_OK) != 0 {
                return option(a, 1, "force") ? undefined() : fail("ENOENT: no such file or directory, rm '\(p)'", "ENOENT")
            }
            do { try FileManager.default.removeItem(atPath: p) } catch { return fail("EPERM: could not remove '\(p)'", "EPERM") }
            return undefined()
        }, forProperty: "rmSync")

        fs.setValue(fn { a in
            let p = string(a, 0)
            guard let names = try? FileManager.default.contentsOfDirectory(atPath: p) else {
                return access(p, F_OK) == 0
                    ? fail("ENOTDIR: not a directory, scandir '\(p)'", "ENOTDIR")
                    : fail("ENOENT: no such file or directory, scandir '\(p)'", "ENOENT")
            }
            let withTypes = option(a, 1, "withFileTypes")
            let arr = JSValue(newArrayIn: ctx)!
            for (i, name) in names.sorted().enumerated() {
                guard withTypes else { arr.setValue(name, at: i); continue }
                var st = stat()
                let full = (p as NSString).appendingPathComponent(name)
                let kind: mode_t = lstat(full, &st) == 0 ? (st.st_mode & S_IFMT) : 0
                let d = JSValue(newObjectIn: ctx)!
                d.setValue(name, forProperty: "name")
                d.setValue(fnBool { kind == S_IFREG }, forProperty: "isFile")
                d.setValue(fnBool { kind == S_IFDIR }, forProperty: "isDirectory")
                arr.setValue(d, at: i)
            }
            return arr
        }, forProperty: "readdirSync")

        // MARK: path

        path.setValue("/", forProperty: "sep")
        path.setValue(fn { a in
            value(normalize(a.compactMap { $0.toString() }.filter { !$0.isEmpty }.joined(separator: "/")))
        }, forProperty: "join")
        path.setValue(fn { a in value(dirname(string(a, 0))) }, forProperty: "dirname")
        path.setValue(fn { a in value((normalize(string(a, 0)) as NSString).lastPathComponent) }, forProperty: "basename")
        path.setValue(fn { a in
            let from = normalize(string(a, 0)), to = normalize(string(a, 1))
            if to == from { return value("") }
            if to.hasPrefix(from + "/") { return value(String(to.dropFirst(from.count + 1))) }
            return value(to)                                          // good enough for our callers
        }, forProperty: "relative")

        // MARK: os

        os.setValue(fn { _ in value(home) }, forProperty: "homedir")
        os.setValue(fn { _ in value(NSTemporaryDirectory()) }, forProperty: "tmpdir")
        os.setValue(fn { _ in value("darwin") }, forProperty: "platform")

        // MARK: process & console

        let out = JSValue(newObjectIn: context)!
        out.setValue(fn { a in
            FileHandle.standardOutput.write(Data(string(a, 0).utf8)); return value(true)
        }, forProperty: "write")
        let err = JSValue(newObjectIn: context)!
        err.setValue(fn { a in
            FileHandle.standardError.write(Data(string(a, 0).utf8)); return value(true)
        }, forProperty: "write")

        process.setValue(Int(getpid()), forProperty: "pid")
        process.setValue("darwin", forProperty: "platform")
        process.setValue(ProcessInfo.processInfo.environment, forProperty: "env")
        process.setValue(["pulse-hook", script] + extraArgs, forProperty: "argv")
        process.setValue(out, forProperty: "stdout")
        process.setValue(err, forProperty: "stderr")
        process.setValue(fn { _ in value(FileManager.default.currentDirectoryPath) }, forProperty: "cwd")
        process.setValue(fn { a in
            exit(a.first.map { $0.isNumber ? $0.toInt32() : 0 } ?? 0)
        }, forProperty: "exit")

        func line(_ a: [JSValue]) -> Data { Data((a.compactMap { $0.toString() }.joined(separator: " ") + "\n").utf8) }
        console.setValue(fn { a in FileHandle.standardOutput.write(line(a)); return undefined() }, forProperty: "log")
        console.setValue(fn { a in FileHandle.standardOutput.write(line(a)); return undefined() }, forProperty: "info")
        console.setValue(fn { a in FileHandle.standardError.write(line(a)); return undefined() }, forProperty: "error")
        console.setValue(fn { a in FileHandle.standardError.write(line(a)); return undefined() }, forProperty: "warn")

        // MARK: globals

        let modules = ["fs": fs, "path": path, "os": os]
        let g = context.globalObject!
        g.setValue(fn { a in
            var name = string(a, 0)
            if name.hasPrefix("node:") { name.removeFirst(5) }
            return modules[name] ?? fail("Cannot find module '\(name)'", "MODULE_NOT_FOUND")
        }, forProperty: "require")
        g.setValue(process, forProperty: "process")
        g.setValue(console, forProperty: "console")
        g.setValue((script as NSString).deletingLastPathComponent, forProperty: "__dirname")
        g.setValue(script, forProperty: "__filename")

        // Node has Atomics.wait; JavaScriptCore gives no SharedArrayBuffer here.
        g.setValue(fn { a in
            usleep(useconds_t(max(0, min(1000, number(a, 0))) * 1000)); return undefined()
        }, forProperty: "__pulseSleep")

        // Complete lines from a byte range, and how many BYTES they span — the
        // usage scanner's incremental offset must count bytes, not characters.
        g.setValue(fn { a in
            let p = string(a, 0)
            let offset = off_t(number(a, 1)), len = Int(number(a, 2))
            let o = JSValue(newObjectIn: ctx)!
            o.setValue("", forProperty: "text")
            o.setValue(0, forProperty: "consumed")
            guard len > 0 else { return o }
            let fd = open(p, O_RDONLY)
            if fd < 0 { return failErrno("open", p) }
            defer { close(fd) }
            var buf = [UInt8](repeating: 0, count: len)
            let n = buf.withUnsafeMutableBytes { pread(fd, $0.baseAddress, len, offset) }
            guard n > 0, let end = buf[0..<n].lastIndex(of: 10) else { return o }
            o.setValue(String(decoding: buf[0..<end], as: UTF8.self), forProperty: "text")
            o.setValue(end + 1, forProperty: "consumed")
            return o
        }, forProperty: "__pulseReadLines")
    }
}

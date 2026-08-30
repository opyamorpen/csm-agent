import Cocoa
import WebKit

#if canImport(Darwin)
import Darwin
#endif

// Values baked in by scripts/build-mac-app.sh at build time.
let nodeBin = "__NODE_BIN__"
let repoDir = "__REPO_DIR__"
let npxDir = "__NPX_DIR__"
let csmPort = "__CSM_PORT__"

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow?
    var webView: WKWebView?
    var server: Process?
    // Subprocess supervision: restart with backoff when the node server exits
    // (crash, or self-exit after detecting a fresh build via CSM_SUPERVISED).
    var serverRestartDelay: TimeInterval = 1.0
    var serverStartedAt: Date?

    func applicationDidFinishLaunching(_ notification: Notification) {
        startServer()
        setupMenu()
        setupWindow()
        loadApp()
    }

    // WKWebView handles paste through the responder chain. A native app needs
    // an Edit menu to expose the standard Cmd+C/X/V shortcuts to that chain.
    func setupMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu(title: "CSM Agent")
        appMenu.addItem(withTitle: "关于 CSM Agent", action: nil, keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "退出 CSM Agent", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: #selector(UndoManager.undo), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: #selector(UndoManager.redo), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSResponder.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        NSApp.mainMenu = mainMenu
    }

    // The launchd service (if installed) already owns the port; only spawn our
    // own server when nothing is listening, so we never double-start.
    func startServer() {
        if portHasListener(csmPort) {
            NSLog("Port \(csmPort) already served (launchd); reusing existing service")
            return
        }
        spawnServer()
    }

    func spawnServer() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: nodeBin)
        p.arguments = [repoDir + "/dist/index.js"]
        p.currentDirectoryURL = URL(fileURLWithPath: repoDir)
        var env = ProcessInfo.processInfo.environment
        env["CSM_PORT"] = csmPort
        // Mark the child as supervised: it self-exits (exit 0) when it detects a
        // fresh build on disk, expecting the supervisor here to restart it.
        env["CSM_SUPERVISED"] = "1"
        // GUI apps launched from Finder lack the shell PATH (nvm's npx etc.),
        // so prepend the npx directory so ONES's `npx mcp-remote` can spawn.
        if !npxDir.isEmpty {
            if let existing = env["PATH"], !existing.isEmpty {
                env["PATH"] = npxDir + ":" + existing
            } else {
                env["PATH"] = npxDir
            }
        }
        p.environment = env
        // Supervise the child: auto-restart on any exit (crash or build swap).
        // Backoff doubles per short-lived restart (1s..60s cap) and resets after
        // 60s of stable uptime, so a crash loop stays gentle while normal build
        // swaps restart immediately.
        p.terminationHandler = { [weak self] process in
            guard let self = self, process === self.server else { return }
            let uptime = self.serverStartedAt.map { Date().timeIntervalSince($0) } ?? 0
            self.server = nil
            if uptime >= 60 {
                self.serverRestartDelay = 1.0
            } else {
                self.serverRestartDelay = min(self.serverRestartDelay * 2, 60.0)
            }
            NSLog("Server exited (status \(process.terminationStatus)); restarting in \(Int(self.serverRestartDelay))s")
            DispatchQueue.main.asyncAfter(deadline: .now() + self.serverRestartDelay) { [weak self] in
                guard let self = self, self.server == nil, !portHasListener(csmPort) else { return }
                self.spawnServer()
            }
        }
        do {
            try p.run()
            server = p
            serverStartedAt = Date()
        } catch {
            NSLog("Failed to start server: \(error)")
        }
    }

    // A cheap TCP connect probe: success means some process listens on the port.
    func portHasListener(_ port: String) -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)"), let host = url.host,
              let portNumber = UInt16(port) else { return false }
        let socketFD = socket(AF_INET, SOCK_STREAM, 0)
        guard socketFD >= 0 else { return false }
        defer { close(socketFD) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = portNumber.bigEndian
        guard inet_pton(AF_INET, host.cString(using: .utf8), &addr.sin_addr) == 1 else { return false }
        let result = withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                connect(socketFD, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return result == 0
    }

    func setupWindow() {
        let rect = NSRect(x: 0, y: 0, width: 1120, height: 780)
        let win = NSWindow(contentRect: rect,
                           styleMask: [.titled, .closable, .miniaturizable, .resizable],
                           backing: .buffered,
                           defer: false)
        win.title = "CSM Agent"
        win.center()

        let config = WKWebViewConfiguration()
        let wv = WKWebView(frame: rect, configuration: config)
        wv.navigationDelegate = self
        wv.uiDelegate = self
        win.contentView = wv

        win.makeKeyAndOrderFront(nil)
        window = win
        webView = wv
    }

    func loadApp() {
        guard let url = URL(string: "http://127.0.0.1:\(csmPort)") else { return }
        webView?.load(URLRequest(url: url))
    }

    // Links opened with target="_blank" do not navigate unless WKWebView has
    // a UI delegate. Send ONES detail links to the user's default browser.
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard navigationAction.targetFrame == nil,
              let url = navigationAction.request.url else { return nil }
        NSWorkspace.shared.open(url)
        return nil
    }

    // Without these panels window.confirm()/alert()/prompt() silently fail
    // (confirm returns false, alert shows nothing), which broke draft confirmation.
    func webView(_ webView: WKWebView,
                 runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "CSM Agent"
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "CSM Agent"
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        alert.addButton(withTitle: "取消")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = "CSM Agent"
        alert.informativeText = prompt
        alert.addButton(withTitle: "好")
        alert.addButton(withTitle: "取消")
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        input.stringValue = defaultText ?? ""
        alert.accessoryView = input
        if alert.runModal() == .alertFirstButtonReturn {
            completionHandler(input.stringValue)
        } else {
            completionHandler(nil)
        }
    }

    // File inputs (对话附件「＋」) present no panel without this delegate —
    // the same silent-failure class as the JS panels above: the click does
    // nothing and nothing logs, so it looks like a dead button.
    func webView(_ webView: WKWebView,
                 runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.message = "选择要附带到对话的文件"
        if panel.runModal() == .OK {
            completionHandler(panel.urls)
        } else {
            completionHandler(nil)
        }
    }

    // Retry until the Node server is up (it takes a moment to boot).
    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation navigation: WKNavigation?,
                 withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.loadApp()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        server?.terminate() // nil when we reused the launchd service
        server = nil // prevent the terminationHandler from restarting during quit
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.activate(ignoringOtherApps: true)
app.run()

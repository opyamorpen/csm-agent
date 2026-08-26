import Cocoa
import WebKit

// Values baked in by scripts/build-mac-app.sh at build time.
let nodeBin = "__NODE_BIN__"
let repoDir = "__REPO_DIR__"
let npxDir = "__NPX_DIR__"

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow?
    var webView: WKWebView?
    var server: Process?

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

    func startServer() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: nodeBin)
        p.arguments = [repoDir + "/dist/index.js"]
        p.currentDirectoryURL = URL(fileURLWithPath: repoDir)
        var env = ProcessInfo.processInfo.environment
        env["CSM_PORT"] = "3210"
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
        do {
            try p.run()
            server = p
        } catch {
            NSLog("Failed to start server: \(error)")
        }
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
        guard let url = URL(string: "http://127.0.0.1:3210") else { return }
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

    // Retry until the Node server is up (it takes a moment to boot).
    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation navigation: WKNavigation?,
                 withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.loadApp()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        server?.terminate()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.activate(ignoringOtherApps: true)
app.run()

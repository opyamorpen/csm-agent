import Cocoa
import WebKit

// Values baked in by scripts/build-mac-app.sh at build time.
let nodeBin = "__NODE_BIN__"
let repoDir = "__REPO_DIR__"

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow?
    var webView: WKWebView?
    var server: Process?

    func applicationDidFinishLaunching(_ notification: Notification) {
        startServer()
        setupWindow()
        loadApp()
    }

    func startServer() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: nodeBin)
        p.arguments = [repoDir + "/dist/index.js"]
        p.currentDirectoryURL = URL(fileURLWithPath: repoDir)
        var env = ProcessInfo.processInfo.environment
        env["CSM_PORT"] = "3210"
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
        win.contentView = wv

        win.makeKeyAndOrderFront(nil)
        window = win
        webView = wv
    }

    func loadApp() {
        guard let url = URL(string: "http://127.0.0.1:3210") else { return }
        webView?.load(URLRequest(url: url))
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

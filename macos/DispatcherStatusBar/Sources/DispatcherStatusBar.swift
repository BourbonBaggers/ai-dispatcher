import AppKit
import WebKit

private let defaultDashboardURL = "http://127.0.0.1:8787/compact"

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
  private var statusItem: NSStatusItem!
  private let popover = NSPopover()
  private var webView: WKWebView!

  private var dashboardURL: URL {
    let configured = UserDefaults.standard.string(forKey: "DashboardURL") ?? defaultDashboardURL
    return URL(string: configured) ?? URL(string: defaultDashboardURL)!
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)

    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = self

    let viewController = NSViewController()
    viewController.view = webView
    popover.contentViewController = viewController
    popover.contentSize = NSSize(width: 420, height: 620)
    popover.behavior = .transient

    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let button = statusItem.button {
      button.title = "AD"
      button.toolTip = "AI Dispatcher status"
      button.target = self
      button.action = #selector(togglePopover(_:))
    }

    loadDashboard()
  }

  @objc private func togglePopover(_ sender: AnyObject?) {
    guard let button = statusItem.button else { return }
    if popover.isShown {
      popover.performClose(sender)
      return
    }
    loadDashboard()
    popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
  }

  private func loadDashboard() {
    webView.load(URLRequest(url: dashboardURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8))
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    showOffline(error)
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    showOffline(error)
  }

  private func showOffline(_ error: Error) {
    let escapedURL = escapeHTML(dashboardURL.absoluteString)
    let escapedError = escapeHTML(error.localizedDescription)
    webView.loadHTMLString(
      """
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body {
            margin: 0;
            padding: 18px;
            font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            color: #17202a;
            background: #ffffff;
          }
          h1 { margin: 0 0 8px; font-size: 18px; }
          p { margin: 0 0 12px; color: #657286; line-height: 1.4; }
          code {
            display: block;
            padding: 10px;
            border: 1px solid #d8e0e8;
            border-radius: 6px;
            overflow-wrap: anywhere;
            color: #17202a;
            background: #f5f7fa;
          }
          button {
            margin-top: 14px;
            border: 1px solid #176b87;
            border-radius: 6px;
            padding: 8px 12px;
            color: #ffffff;
            background: #176b87;
            font: inherit;
          }
        </style>
      </head>
      <body>
        <h1>Dispatcher unavailable</h1>
        <p>The menu bar app could not load the dispatcher dashboard.</p>
        <code>\(escapedURL)</code>
        <p>\(escapedError)</p>
        <button onclick="location.reload()">Retry</button>
      </body>
      </html>
      """,
      baseURL: nil,
    )
  }
}

private func escapeHTML(_ value: String) -> String {
  var escaped = value.replacingOccurrences(of: "&", with: "&amp;")
  escaped = escaped.replacingOccurrences(of: "<", with: "&lt;")
  escaped = escaped.replacingOccurrences(of: ">", with: "&gt;")
  escaped = escaped.replacingOccurrences(of: "\"", with: "&quot;")
  escaped = escaped.replacingOccurrences(of: "'", with: "&#39;")
  return escaped
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()

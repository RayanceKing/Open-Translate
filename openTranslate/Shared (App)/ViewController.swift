//
//  ViewController.swift
//  Shared (App)
//
//  Created by 王宇亮 on 10/31/26.
//

import WebKit

#if os(iOS)
import UIKit
typealias PlatformViewController = UIViewController
#elseif os(macOS)
import Cocoa
import SafariServices
typealias PlatformViewController = NSViewController
#endif

let extensionBundleIdentifier = "com.stuwang.openTranslate.Extension"

class ViewController: PlatformViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self

#if os(iOS)
        self.webView.scrollView.isScrollEnabled = false
#endif

        self.webView.configuration.userContentController.add(self, name: "controller")

        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
#if os(iOS)
        webView.evaluateJavaScript("show('ios')")
#elseif os(macOS)
        refreshExtensionState()
#endif
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let action = message.body as? String else {
            return
        }

#if os(iOS)
        guard action == "open-settings",
              let settingsURL = URL(string: "App-Prefs:root=SAFARI") else {
            return
        }
        UIApplication.shared.open(settingsURL)
#elseif os(macOS)
        guard action == "open-preferences" else { return }
        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { _ in }
#endif
    }

#if os(macOS)
    private func refreshExtensionState() {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { state, error in
            guard error == nil, let state else { return }
            DispatchQueue.main.async {
                let usesSettings: Bool
                if #available(macOS 13, *) {
                    usesSettings = true
                } else {
                    usesSettings = false
                }
                self.webView.evaluateJavaScript(
                    "show('mac', \(state.isEnabled), \(usesSettings))"
                )
            }
        }
    }
#endif

}

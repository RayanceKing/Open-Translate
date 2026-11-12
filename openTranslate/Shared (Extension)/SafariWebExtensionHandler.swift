//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Created by 王宇亮 on 10/31/26.
//

import SafariServices
import os.log
import Foundation
import Security
import Translation
import NaturalLanguage
import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private var translationBridges: [UUID: Any] = [:]

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let profile: UUID?
        if #available(iOS 17.0, macOS 14.0, *) {
            profile = request?.userInfo?[SFExtensionProfileKey] as? UUID
        } else {
            profile = request?.userInfo?["profile"] as? UUID
        }

        let message: [String: Any]?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey] as? [String: Any]
        } else {
            message = request?.userInfo?["message"] as? [String: Any]
        }

        os_log(.default, "Received message from extension: %@ (profile: %@)", String(describing: message), profile?.uuidString ?? "none")

        if message?["type"] as? String == "translate" {
            handleTranslate(message, context: context)
            return
        }

        // Relay an HTTP request through this native process. B站's WAF answers
        // browser-extension requests (Origin: safari-web-extension://…) with an
        // HTML 412 page; a URLSession request has no such header.
        // iOS/iPadOS cannot push from the app into the extension, so this is
        // always a strict request/reply round-trip initiated by the extension.
        if message?["type"] as? String == "http" {
            handleNetworkRequest(message, context: context)
            return
        }

        // Secrets (API keys) live in the system Keychain — never in iCloud.
        if message?["type"] as? String == "secret" {
            handleSecret(message, context: context)
            return
        }

        // Settings are mirrored to iCloud Key-Value Storage for cross-device sync.
        if message?["type"] as? String == "settings" {
            handleSettings(message, context: context)
            return
        }

        // Everything else: echo back for diagnostics.
        let response = NSExtensionItem()
        let payload: [String: Any] = ["echo": message ?? NSNull()]
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: payload]
        } else {
            response.userInfo = ["message": payload]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    private func handleTranslate(_ message: [String: Any]?, context: NSExtensionContext) {
        guard let texts = message?["texts"] as? [String], !texts.isEmpty else {
            complete(context: context, reply: ["error": "缺少待翻译文本"])
            return
        }
        let target = (message?["target"] as? String) ?? "zh-CN"
        let source = message?["source"] as? String
        guard #available(iOS 18.0, macOS 15.0, *) else {
            complete(context: context, reply: ["error": "系统翻译需要 iOS 18.0 / macOS 15.0 及以上系统"])
            return
        }
        let id = UUID()
        let contextBox = ExtensionContextBox(context)
        Task { @MainActor [weak self, contextBox] in
            guard let self else { return }
            let bridge = TranslationBridge(texts: texts, source: source, target: target) { [weak self] result in
                guard let self else { return }
                self.translationBridges.removeValue(forKey: id)
                switch result {
                case .success(let values):
                    self.complete(context: contextBox.value, reply: ["texts": values])
                case .failure(let error):
                    self.complete(context: contextBox.value, reply: ["error": error.localizedDescription])
                }
            }
            self.translationBridges[id] = bridge
            bridge.start()
        }
    }

    /// Wrap the reply dictionary in an NSExtensionItem and hand it back to the
    /// calling background script. This is the ONLY reply channel available to a
    /// Safari app extension; the app can never initiate a message on its own.
    private func complete(context: NSExtensionContext, reply: [String: Any]) {
        Self.reply(context: context, with: reply)
    }

    /// Static so URLSession callbacks can finish a request without capturing a
    /// non-Sendable `self` across the concurrency boundary.
    private static func reply(context: NSExtensionContext, with fields: [String: Any]) {
        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: fields]
        } else {
            response.userInfo = ["message": fields]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    // MARK: - Native HTTP forwarding

    private static let forwardHosts: Set<String> = ["index-translate.bilibili.com"]
    private static let forwardMethods: Set<String> = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]
    // Whitelist only. Origin / Referer / User-Agent / Sec-Fetch-* never cross
    // the JS -> Swift boundary, so no browser-extension fingerprint is copied.
    private static let allowedRequestHeaders: Set<String> = [
        "content-type", "authorization", "accept", "accept-language"
    ]
    private static let requestTimeout: TimeInterval = 10

    /// An honest native-App identifier. Never spoof a browser or another app.
    private static let appUserAgent: String = {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        #if os(iOS)
        return "OpenTranslate/\(version) (iOS; SafariExtension)"
        #else
        return "OpenTranslate/\(version) (macOS; SafariExtension)"
        #endif
    }()

    private func handleNetworkRequest(_ message: [String: Any]?, context: NSExtensionContext) {
        guard let payload = message else {
            complete(context: context, reply: ["error": "缺少原生转发参数", "status": 0])
            return
        }
        let contextBox = ExtensionContextBox(context)
        performNativeRequest(payload: payload) { reply in
            let replyBox = NativeReplyBox(reply)
            Task { @MainActor in
                Self.reply(context: contextBox.value, with: replyBox.value)
            }
        }
    }

    /// Build a plain native request, issue it with URLSession.shared, and hand
    /// the upstream JSON back to the extension. `completion` runs exactly once.
    private func performNativeRequest(payload: [String: Any],
                                      completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let rawURL = payload["url"] as? String,
              let url = URL(string: rawURL),
              let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = url.host?.lowercased(), Self.forwardHosts.contains(host) else {
            completion(["error": "原生转发仅支持白名单内的接口地址", "status": 0])
            return
        }
        let method = (payload["method"] as? String ?? "GET").uppercased()
        guard Self.forwardMethods.contains(method) else {
            completion(["error": "不支持的 HTTP 方法: \(method)", "status": 0])
            return
        }
        let requested = (payload["timeout"] as? NSNumber)?.doubleValue ?? Self.requestTimeout
        let seconds = min(30.0, max(1.0, requested))

        var request = URLRequest(url: url,
                                 cachePolicy: .reloadIgnoringLocalCacheData,
                                 timeoutInterval: seconds)
        request.httpMethod = method
        // URLSession.shared uses URLSessionConfiguration.default, whose
        // httpAdditionalHeaders is nil. We never assign it. URLRequest's own
        // timeoutInterval overrides the session's 60s default.
        // The whitelist below makes it impossible for a caller to inject an
        // Origin / Referer / Sec-Fetch-* or an extension User-Agent.
        for (name, value) in (payload["headers"] as? [String: String] ?? [:]) {
            guard Self.allowedRequestHeaders.contains(name.lowercased()) else { continue }
            request.setValue(value, forHTTPHeaderField: name)
        }
        if request.value(forHTTPHeaderField: "Content-Type") == nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        request.setValue(Self.appUserAgent, forHTTPHeaderField: "User-Agent")
        if method != "GET" && method != "HEAD", let body = payload["body"] as? String {
            request.httpBody = Data(body.utf8)
        }

        os_log(.default, "Native HTTP relay: %@ %@", method, url.absoluteString)

        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error as? URLError, error.code == .timedOut {
                completion(["error": "原生网络请求超时（\(Int(seconds)) 秒）", "status": 0])
                return
            }
            if let error = error {
                completion(["error": "原生网络请求失败：\(error.localizedDescription)", "status": 0])
                return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let body = data ?? Data()
            let snippet = String(decoding: body.prefix(2048), as: UTF8.self)
            guard (200...299).contains(status) else {
                var reply: [String: Any] = [
                    "error": "HTTP \(status)",
                    "status": status,
                    "body": snippet
                ]
                if status == 412 {
                    reply["error"] = "HTTP 412：B 站风控仍拦截了原生请求，请稍后重试或改用本地桥接 / 自建端点"
                }
                completion(reply)
                return
            }
            guard !body.isEmpty,
                  let json = try? JSONSerialization.jsonObject(with: body, options: .fragmentsAllowed) else {
                completion(["error": "接口返回的不是合法 JSON", "status": status, "body": snippet])
                return
            }
            // NSExtensionItem.userInfo is plist-backed and cannot carry NSNull.
            // `raw` is the lossless JSON text channel; `data` is a cleaned JSON
            // dictionary so the reply is still a plain JSON object.
            completion([
                "ok": true,
                "status": status,
                "data": Self.plistSafe(json),
                "raw": String(decoding: body, as: UTF8.self)
            ])
        }
        task.resume()
    }

    private static func plistSafe(_ value: Any) -> Any {
        if value is NSNull { return "" }
        if let dictionary = value as? [String: Any] {
            var result: [String: Any] = [:]
            for (key, nested) in dictionary { result[key] = plistSafe(nested) }
            return result
        }
        if let array = value as? [Any] { return array.map(plistSafe) }
        return value
    }

    // MARK: - Secrets (system Keychain)

    // API keys are stored in the app/extension Keychain, encrypted at rest by the
    // system. They are intentionally NOT iCloud-synchronizable, so a key never
    // leaves the device it was entered on.
    private let keychainService = "com.stuwang.openTranslate.secrets"

    private func readSecret(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8) else { return nil }
        return value
    }

    @available(iOS 18.0, macOS 15.0, *)
    @MainActor
    private final class TranslationBridge {
        private let texts: [String]
        private let source: String?
        private let target: String
        private let completion: (Result<[String], Error>) -> Void
        private var host: TranslationHostController?
        private var finished = false
        private var watchdog: Task<Void, Never>?
        #if os(iOS)
        private var window: UIWindow?
        #else
        private var window: NSWindow?
        #endif

        // Below the JS-side 25s timeout, so every window is torn down before
        // the caller gives up even if the framework never calls back.
        private static let timeoutSeconds: Int = 20

        init(texts: [String], source: String?, target: String, completion: @escaping (Result<[String], Error>) -> Void) {
            self.texts = texts
            self.source = source
            self.target = target
            self.completion = completion
        }

        func start() {
            // Apple's Translation framework presents a system "cannot detect
            // the language / choose a source language" panel when
            // Configuration.source is nil and auto-detection is uncertain
            // (WWDC24, "Meet the Translation API"). Inside a Safari app
            // extension that panel has no dismissible host window: it stays on
            // screen, cannot be interacted with, and one is created per batch.
            // Always supply an explicit source language instead.
            let configuration = TranslationSession.Configuration(
                source: Self.resolveSourceLanguage(requested: source, texts: texts),
                target: Locale.Language(identifier: target)
            )
            let view = TranslationTaskView(configuration: configuration, texts: texts) { [weak self] result in
                self?.finish(result)
            }
            let controller = TranslationHostController(rootView: view)
            host = controller
            #if os(iOS)
            let window = UIWindow(frame: .zero)
            window.rootViewController = controller
            window.isHidden = false
            self.window = window
            #else
            let window = NSWindow(contentViewController: controller)
            // SwiftUI needs the view inside a window for .translationTask, but
            // the window must never appear on screen (frame (0,0) on macOS is
            // the bottom-left corner — exactly where the panels piled up).
            window.setFrame(NSRect(x: -20000, y: -20000, width: 1, height: 1), display: false)
            window.isOpaque = false
            window.backgroundColor = .clear
            window.ignoresMouseEvents = true
            window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
            window.orderFrontRegardless()
            self.window = window
            #endif

            watchdog = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(Self.timeoutSeconds))
                guard let self, !self.finished else { return }
                self.finish(.failure(NSError(
                    domain: "com.stuwang.openTranslate.translation",
                    code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "系统翻译超时，请确认已下载对应语言包，或在设置中显式指定原文语言"]
                )))
            }
        }

        /// Never returns nil. An explicit user choice wins; otherwise detect
        /// with NLLanguageRecognizer — Apple's recommended way to derive a
        /// Locale.Language without asking the framework to auto-detect.
        private static func resolveSourceLanguage(requested: String?, texts: [String]) -> Locale.Language {
            if let requested, !requested.isEmpty, requested != "auto" {
                return Locale.Language(identifier: requested)
            }
            let sample = String(texts.joined(separator: "\n").prefix(4000))
            let recognizer = NLLanguageRecognizer()
            recognizer.processString(sample)
            return Locale.Language(identifier: recognizer.dominantLanguage?.rawValue ?? "en")
        }

        private func finish(_ result: Result<[String], Error>) {
            guard !finished else { return }
            finished = true
            watchdog?.cancel()
            watchdog = nil
            completion(result)
            stop()
        }

        private func stop() {
            #if os(iOS)
            window?.isHidden = true
            #else
            window?.orderOut(nil)
            #endif
            window = nil
            host = nil
        }
    }

    @available(iOS 18.0, macOS 15.0, *)
    private struct TranslationTaskView: View {
        let configuration: TranslationSession.Configuration
        let texts: [String]
        let completion: (Result<[String], Error>) -> Void

        var body: some View {
            Color.clear
                .frame(width: 1, height: 1)
                .translationTask(configuration) { session in
                    do {
                        var values: [String] = []
                        for text in texts {
                            values.append(try await session.translate(text).targetText)
                        }
                        completion(.success(values))
                    } catch {
                        completion(.failure(error))
                    }
                }
        }
    }

    #if os(iOS)
    @available(iOS 18.0, *)
    private typealias TranslationHostController = UIHostingController<TranslationTaskView>
    #else
    @available(macOS 15.0, *)
    private typealias TranslationHostController = NSHostingController<TranslationTaskView>
    #endif

    private func writeSecret(account: String, value: String) {
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(deleteQuery as CFDictionary)
        guard !value.isEmpty else { return }
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: account,
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlocked
            // Not kSecAttrSynchronizable — secrets stay on this device only.
        ]
        SecItemAdd(addQuery as CFDictionary, nil)
    }

    private func readAllSecrets() -> [String: String] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecReturnAttributes as String: true,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return [:] }
        guard let rows = item as? [[String: Any]] else { return [:] }
        var result: [String: String] = [:]
        for row in rows {
            if let account = row[kSecAttrAccount as String] as? String,
               let data = row[kSecValueData as String] as? Data,
               let value = String(data: data, encoding: .utf8) {
                result[account] = value
            }
        }
        return result
    }

    private func handleSecret(_ message: [String: Any]?, context: NSExtensionContext) {
        guard let action = message?["action"] as? String else {
            complete(context: context, reply: ["error": "缺少 secret 操作"])
            return
        }
        if action == "get" {
            complete(context: context, reply: ["secrets": readAllSecrets()])
            return
        }
        guard let engine = message?["engine"] as? String, !engine.isEmpty else {
            complete(context: context, reply: ["error": "缺少引擎标识"])
            return
        }
        if action == "set" {
            let value = (message?["value"] as? String) ?? ""
            writeSecret(account: engine, value: value)
            complete(context: context, reply: ["ok": true])
            return
        }
        if action == "delete" {
            writeSecret(account: engine, value: "")
            complete(context: context, reply: ["ok": true])
            return
        }
        complete(context: context, reply: ["error": "未知 secret 操作: \(action)"])
    }

    // MARK: - Settings (iCloud Key-Value Storage)

    // Non-secret settings are mirrored to iCloud KVS so they follow the user
    // across iPhone / iPad / Mac. A local UserDefaults copy keeps everything
    // working when iCloud is unavailable (not signed in, no entitlement, …).
    private let ubiquityStore = NSUbiquitousKeyValueStore.default
    private let settingsKey = "settings"

    private func readCloudSettings() -> [String: Any]? {
        if let data = ubiquityStore.object(forKey: settingsKey) as? Data,
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return object
        }
        if let data = UserDefaults.standard.data(forKey: settingsKey),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return object
        }
        return nil
    }

    private func writeCloudSettings(_ settings: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: settings) else { return }
        ubiquityStore.set(data, forKey: settingsKey)
        ubiquityStore.synchronize()
        UserDefaults.standard.set(data, forKey: settingsKey)
    }

    private func handleSettings(_ message: [String: Any]?, context: NSExtensionContext) {
        guard let action = message?["action"] as? String else {
            complete(context: context, reply: ["error": "缺少 settings 操作"])
            return
        }
        if action == "get" {
            complete(context: context, reply: ["settings": readCloudSettings() ?? [:]])
            return
        }
        if action == "set" {
            guard let settings = message?["settings"] as? [String: Any] else {
                complete(context: context, reply: ["error": "缺少 settings 数据"])
                return
            }
            writeCloudSettings(settings)
            complete(context: context, reply: ["ok": true])
            return
        }
        complete(context: context, reply: ["error": "未知 settings 操作: \(action)"])
    }

}

private final class ExtensionContextBox: @unchecked Sendable {
    let value: NSExtensionContext

    init(_ value: NSExtensionContext) {
        self.value = value
    }
}

/// URLSession callbacks arrive on a background queue; this box carries the
/// plist-safe reply dictionary back to the main actor without losing it.
private final class NativeReplyBox: @unchecked Sendable {
    let value: [String: Any]

    init(_ value: [String: Any]) {
        self.value = value
    }
}

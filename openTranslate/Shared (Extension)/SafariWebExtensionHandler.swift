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

    private func complete(context: NSExtensionContext, reply: [String: Any]) {
        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: reply]
        } else {
            response.userInfo = ["message": reply]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
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
        #if os(iOS)
        private var window: UIWindow?
        #else
        private var window: NSWindow?
        #endif

        init(texts: [String], source: String?, target: String, completion: @escaping (Result<[String], Error>) -> Void) {
            self.texts = texts
            self.source = source
            self.target = target
            self.completion = completion
        }

        func start() {
            let configuration = TranslationSession.Configuration(
                source: source.flatMap { $0 == "auto" ? nil : Locale.Language(identifier: $0) },
                target: Locale.Language(identifier: target)
            )
            let view = TranslationTaskView(configuration: configuration, texts: texts) { [weak self] result in
                guard let self else { return }
                completion(result)
                stop()
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
            window.setFrame(NSRect(x: 0, y: 0, width: 1, height: 1), display: false)
            window.orderFrontRegardless()
            self.window = window
            #endif
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
        @State private var completed = false

        var body: some View {
            Color.clear
                .frame(width: 1, height: 1)
                .translationTask(configuration) { session in
                    guard !completed else { return }
                    do {
                        var values: [String] = []
                        for text in texts {
                            values.append(try await session.translate(text).targetText)
                        }
                        completed = true
                        completion(.success(values))
                    } catch {
                        completed = true
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

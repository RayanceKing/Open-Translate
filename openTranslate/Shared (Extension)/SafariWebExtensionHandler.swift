//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Created by 王宇亮 on 10/31/26.
//

import SafariServices
import os.log
import Translation

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let profile: UUID?
        if #available(iOS 26.0, macOS 26.0, *) {
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

        // Route translation to the on-device Translation framework.
        if message?["type"] as? String == "translate" {
            handleTranslate(message, context: context)
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

    // MARK: - On-device system translation

    private func handleTranslate(_ message: [String: Any]?, context: NSExtensionContext) {
        guard let texts = message?["texts"] as? [String], !texts.isEmpty else {
            complete(context: context, reply: ["error": "缺少待翻译文本"])
            return
        }
        let target = (message?["target"] as? String) ?? "zh-CN"
        let source = message?["source"] as? String

        if #available(iOS 26.0, macOS 26.0, *) {
            Task {
                let results = await translateAll(texts: texts, source: source, target: target)
                self.complete(context: context, reply: ["texts": results])
            }
        } else {
            complete(context: context, reply: ["error": "系统翻译需要 iOS 26 / macOS 26 及以上系统"])
        }
    }

    @available(iOS 26.0, macOS 26.0, *)
    @MainActor
    private func translateAll(texts: [String], source: String?, target: String) async -> [String] {
        let targetLanguage = Locale.Language(identifier: target)
        let sourceLanguage: Locale.Language? =
            (source != nil && source != "auto") ? Locale.Language(identifier: source!) : nil

        var results: [String] = []
        for text in texts {
            let installedSource = sourceLanguage ?? detectLanguage(for: text)
            if installedSource.languageCode == targetLanguage.languageCode {
                results.append(text)
                continue
            }

            guard await LanguageAvailability().status(from: installedSource, to: targetLanguage) != .unsupported else {
                results.append(text)
                continue
            }

            do {
                let session = TranslationSession(installedSource: installedSource, target: targetLanguage)
                let response = try await session.translate(text)
                results.append(response.targetText)
            } catch {
                results.append(text)
            }
        }
        return results
    }

    @available(iOS 26.0, macOS 26.0, *)
    private func detectLanguage(for text: String) -> Locale.Language {
        let scalars = text.unicodeScalars
        if scalars.contains(where: { (0x4E00...0x9FFF).contains($0.value) }) {
            return Locale.Language(identifier: "zh")
        }
        if scalars.contains(where: { (0x3040...0x30FF).contains($0.value) }) {
            return Locale.Language(identifier: "ja")
        }
        if scalars.contains(where: { (0xAC00...0xD7AF).contains($0.value) }) {
            return Locale.Language(identifier: "ko")
        }
        if scalars.contains(where: { (0x0400...0x04FF).contains($0.value) }) {
            return Locale.Language(identifier: "ru")
        }
        if scalars.contains(where: { (0x0600...0x06FF).contains($0.value) }) {
            return Locale.Language(identifier: "ar")
        }
        return Locale.Language(identifier: "en")
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
}

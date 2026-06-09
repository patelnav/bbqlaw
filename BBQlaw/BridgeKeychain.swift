import Foundation
import Security

/// Keychain storage for bridge credentials (device token + ingest URL).
enum BridgeKeychain {
    private static let service = "app.bbqlaw.ios.bridge"
    private static let account = "credentials"

    private enum LegacyKey {
        static let deviceToken = "deviceToken"
        static let deviceId = "deviceId"
        static let ingestURL = "ingestURL"
    }

    private struct StoredCredentials: Codable {
        let deviceId: String
        let deviceToken: String
        let ingestURL: String
        let readerToken: String?
    }

    struct Credentials: Equatable {
        let deviceId: String
        let deviceToken: String
        let ingestURL: URL
        let readerToken: String?
    }

    static var credentials: Credentials? {
        if let data = readData(account: account),
           let stored = try? JSONDecoder().decode(StoredCredentials.self, from: data),
           let ingestURL = URL(string: stored.ingestURL) {
            return Credentials(
                deviceId: stored.deviceId,
                deviceToken: stored.deviceToken,
                ingestURL: ingestURL,
                readerToken: stored.readerToken
            )
        }
        return readLegacyCredentials()
    }

    static var isLinked: Bool { credentials != nil }

    @discardableResult
    static func save(deviceId: String, deviceToken: String, ingestURL: URL, readerToken: String? = nil) -> Bool {
        clearLegacyItems()
        let stored = StoredCredentials(
            deviceId: deviceId,
            deviceToken: deviceToken,
            ingestURL: ingestURL.absoluteString,
            readerToken: readerToken
        )
        guard let data = try? JSONEncoder().encode(stored) else { return false }
        return writeData(data, account: account)
    }

    static func clear() {
        delete(account: account)
        clearLegacyItems()
    }

    // MARK: - Legacy migration (three separate keychain items)

    private static func readLegacyCredentials() -> Credentials? {
        guard
            let deviceId = readLegacyString(LegacyKey.deviceId),
            let deviceToken = readLegacyString(LegacyKey.deviceToken),
            let ingestString = readLegacyString(LegacyKey.ingestURL),
            let ingestURL = URL(string: ingestString)
        else { return nil }
        _ = save(deviceId: deviceId, deviceToken: deviceToken, ingestURL: ingestURL)
        return Credentials(deviceId: deviceId, deviceToken: deviceToken, ingestURL: ingestURL, readerToken: nil)
    }

    private static func readLegacyString(_ account: String) -> String? {
        guard let data = readData(account: account) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func clearLegacyItems() {
        delete(account: LegacyKey.deviceId)
        delete(account: LegacyKey.deviceToken)
        delete(account: LegacyKey.ingestURL)
    }

    // MARK: - Keychain primitives

    private static func readData(account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return data
    }

    @discardableResult
    private static func writeData(_ data: Data, account: String) -> Bool {
        delete(account: account)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
            kSecValueData as String: data,
        ]
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    private static func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

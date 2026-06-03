import Foundation
import os

/// Redeems one-time link codes and tracks bridge link state.
@MainActor
final class BridgeLinkManager: ObservableObject {
    @Published private(set) var isLinked = BridgeKeychain.isLinked
    @Published private(set) var deviceId: String?
    @Published private(set) var lastError: String?
    @Published private(set) var lastSuccess: String?

    private static let redeemURL = URL(string: "https://bbqlaw.app/api/link/redeem")!
    private let log = Logger(subsystem: "com.bbqlaw.app", category: "bridge")

    init() {
        deviceId = BridgeKeychain.credentials?.deviceId
    }

    func refreshLinkState() {
        isLinked = BridgeKeychain.isLinked
        deviceId = BridgeKeychain.credentials?.deviceId
    }

    func unlink() {
        BridgeKeychain.clear()
        refreshLinkState()
        lastSuccess = "Bridge unlinked."
        lastError = nil
    }

    /// Redeem a one-time code from bbqlaw://link?code=… or manual entry.
    func redeem(code rawCode: String) async {
        let code = rawCode.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard !code.isEmpty else {
            lastError = "Missing link code."
            return
        }

        lastError = nil
        lastSuccess = nil

        var request = URLRequest(url: Self.redeemURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(["code": code])

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                lastError = "Unexpected response."
                return
            }
            if http.statusCode != 200 {
                let msg = (try? JSONDecoder().decode(RedeemError.self, from: data))?.error
                    ?? "Link failed (HTTP \(http.statusCode))."
                lastError = msg
                return
            }
            let payload = try JSONDecoder().decode(RedeemResponse.self, from: data)
            guard let ingestURL = URL(string: payload.ingestUrl) else {
                lastError = "Invalid ingest URL from relay."
                return
            }
            guard BridgeKeychain.save(
                deviceId: payload.device,
                deviceToken: payload.deviceToken,
                ingestURL: ingestURL
            ) else {
                lastError = "Could not save credentials to Keychain."
                return
            }
            refreshLinkState()
            lastSuccess = "Linked as \(payload.device)."
            log.notice("bridge linked device=\(payload.device, privacy: .public)")
        } catch {
            lastError = error.localizedDescription
        }
    }

    private struct RedeemResponse: Decodable {
        let device: String
        let deviceToken: String
        let ingestUrl: String
    }

    private struct RedeemError: Decodable {
        let error: String
    }
}

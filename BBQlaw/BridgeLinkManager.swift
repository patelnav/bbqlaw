import Foundation
import os

/// In-app pairing with the relay and bridge link state.
@MainActor
final class BridgeLinkManager: ObservableObject {
    @Published private(set) var isLinked = BridgeKeychain.isLinked
    @Published private(set) var deviceId: String?
    @Published private(set) var readerToken: String?
    @Published private(set) var latestUrl: String?
    /// Shareable OpenClaw feed URL (`https://bbqlaw.app/openclaw#<readerToken>`).
    @Published private(set) var shareURL: String?
    @Published private(set) var lastError: String?
    @Published private(set) var lastSuccess: String?

    private let log = Logger(subsystem: "com.bbqlaw.app", category: "bridge")

    init() {
        applyStoredCredentials()
    }

    func refreshLinkState() {
        isLinked = BridgeKeychain.isLinked
        applyStoredCredentials()
    }

    private func applyStoredCredentials() {
        guard let creds = BridgeKeychain.credentials else {
            deviceId = nil
            readerToken = nil
            shareURL = nil
            return
        }
        deviceId = creds.deviceId
        if let token = creds.readerToken, !token.isEmpty {
            readerToken = token
            shareURL = Self.feedURL(readerToken: token)
        } else {
            readerToken = nil
            shareURL = nil
        }
    }

    func unlink() {
        BridgeKeychain.clear()
        readerToken = nil
        latestUrl = nil
        shareURL = nil
        refreshLinkState()
        lastSuccess = "Bridge unlinked."
        lastError = nil
    }

    /// Pair with the relay (phone-initiated); stores device credentials in Keychain.
    func pair() async {
        lastError = nil
        lastSuccess = nil

        var request = URLRequest(url: BridgeRelayConfig.pairURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = "{}".data(using: .utf8)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                lastError = "Unexpected response."
                return
            }
            if http.statusCode != 200 {
                let msg = (try? JSONDecoder().decode(PairError.self, from: data))?.error
                    ?? "Pair failed (HTTP \(http.statusCode))."
                lastError = msg
                return
            }
            let payload = try JSONDecoder().decode(PairResponse.self, from: data)
            guard let ingestURL = URL(string: payload.ingestUrl) else {
                lastError = "Invalid ingest URL from relay."
                return
            }
            guard BridgeKeychain.save(
                deviceId: payload.device,
                deviceToken: payload.deviceToken,
                ingestURL: ingestURL,
                readerToken: payload.readerToken
            ) else {
                lastError = "Could not save credentials to Keychain."
                return
            }
            readerToken = payload.readerToken
            latestUrl = payload.latestUrl
            shareURL = Self.feedURL(readerToken: payload.readerToken)
            refreshLinkState()
            lastSuccess = "Linked as \(payload.device). Copy the feed link for OpenClaw."
            log.notice("bridge paired device=\(payload.device, privacy: .public)")
        } catch {
            lastError = error.localizedDescription
        }
    }

    private struct PairResponse: Decodable {
        let device: String
        let deviceToken: String
        let readerToken: String
        let ingestUrl: String
        let latestUrl: String
    }

    private struct PairError: Decodable {
        let error: String
    }

    private static func feedURL(readerToken: String) -> String {
        "https://bbqlaw.app/openclaw#" + readerToken
    }
}

import Foundation

/// Relay base URL — override for local/preview testing if needed.
enum BridgeRelayConfig {
    static let baseURLString = "https://bbqlaw.app"

    static var pairURL: URL {
        URL(string: "\(baseURLString)/api/pair")!
    }

    static var ingestURL: URL {
        URL(string: "\(baseURLString)/api/ingest")!
    }

    static var latestURL: URL {
        URL(string: "\(baseURLString)/api/latest")!
    }
}

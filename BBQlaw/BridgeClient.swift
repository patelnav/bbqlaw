import Foundation
import os
#if canImport(UIKit)
import UIKit
#endif

/// When linked, POST probe readings to the relay so your OpenClaw can watch the cook.
///
/// BLE-driven (NOT a wall-clock timer): ThermometerManager pokes `onStateChange`
/// on every reading and connection change. The probe streams ~1/sec, and those
/// Bluetooth wake-ups also fire while the app is backgrounded (the
/// `bluetooth-central` mode), so pushes keep going with the screen off — which a
/// `Timer` does not, because iOS freezes timers while the app is suspended.
///
/// Cadence: throttled to ~every 20s; immediate on target-reached; one final
/// `connected:false` when the link drops. No-ops when unlinked.
@MainActor
final class BridgeClient: ObservableObject {
    @Published private(set) var lastPushAt: Date?
    @Published private(set) var lastPushError: String?

    private let thermo: ThermometerManager
    private let log = Logger(subsystem: "com.bbqlaw.app", category: "bridge")
    private var lastTargetReachedPush = false
    private var targetPushInFlight = false
    private var wasConnected = false
    private var lastAttemptAt: Date?
    private var consecutiveFailures = 0
    private let pushInterval: TimeInterval = 20

    private struct ThermoSnapshot {
        let connected: Bool
        let tempF: Double?
        let targetF: Double
        let base: Int?
        let probe: Int?
        let targetReached: Bool
    }

    private enum PushKind {
        case heartbeat
        case target
        case disconnect
        case forced
    }

    init(thermo: ThermometerManager) {
        self.thermo = thermo
        thermo.onStateChange = { [weak self] in self?.onThermoUpdate() }
    }

    func refresh() {
        if !BridgeKeychain.isLinked { lastPushError = nil }
    }

    /// Manual retry / immediate push (e.g. a "retry" button).
    func pushNow() {
        Task { await pushReading(snapshot: captureSnapshot(), kind: .forced) }
    }

    private func captureSnapshot() -> ThermoSnapshot {
        let connected = thermo.connection == .connected
        return ThermoSnapshot(
            connected: connected,
            tempF: connected ? thermo.temperatureF : nil,
            targetF: thermo.targetF,
            base: thermo.baseBattery,
            probe: thermo.probeBattery,
            targetReached: thermo.targetReached
        )
    }

    /// Driven by ThermometerManager on every BLE reading / connection change.
    private func onThermoUpdate() {
        guard BridgeKeychain.isLinked else { return }
        let snapshot = captureSnapshot()

        // Link dropped -> tell the agent the feed ended (vs just going stale).
        if !snapshot.connected {
            if wasConnected {
                wasConnected = false
                lastTargetReachedPush = false
                targetPushInFlight = false
                Task { await pushReading(snapshot: snapshot, kind: .disconnect) }
            }
            return
        }
        wasConnected = true

        // Rising edge of target reached -> push now (same path as the local alarm).
        if snapshot.targetReached {
            if !lastTargetReachedPush, !targetPushInFlight {
                targetPushInFlight = true
                Task { await pushReading(snapshot: snapshot, kind: .target) }
                return
            }
            if targetPushInFlight { return }
        } else {
            lastTargetReachedPush = false
        }

        // Otherwise a throttled heartbeat — gate here so we don't spawn a Task
        // for every ~1/sec reading (uses last attempt + backoff, not last success).
        let effectiveInterval = pushInterval * Double(1 + min(consecutiveFailures, 5))
        if let last = lastAttemptAt, Date().timeIntervalSince(last) < effectiveInterval - 1 { return }
        Task { await pushReading(snapshot: snapshot, kind: .heartbeat) }
    }

    private func pushReading(snapshot: ThermoSnapshot, kind: PushKind) async {
        guard BridgeKeychain.isLinked, let creds = BridgeKeychain.credentials else { return }

        let bypassThrottle = kind != .heartbeat
        if !bypassThrottle {
            let effectiveInterval = pushInterval * Double(1 + min(consecutiveFailures, 5))
            if let last = lastAttemptAt, Date().timeIntervalSince(last) < effectiveInterval - 1 {
                return
            }
        }

        lastAttemptAt = Date()

        let payload = IngestPayload(
            device: creds.deviceId,
            tempF: snapshot.connected ? snapshot.tempF : nil,
            targetF: snapshot.targetF,
            battery: .init(base: snapshot.base, probe: snapshot.probe),
            connected: snapshot.connected,
            ts: Int(Date().timeIntervalSince1970)
        )

        var request = URLRequest(url: creds.ingestURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(creds.deviceToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONEncoder().encode(payload)

        let succeeded = await performNetworkPush(request: request)

        if succeeded {
            lastPushAt = Date()
            lastPushError = nil
            consecutiveFailures = 0
            if kind == .target {
                lastTargetReachedPush = true
                targetPushInFlight = false
            }
        } else {
            consecutiveFailures += 1
            if kind == .target {
                targetPushInFlight = false
            }
        }
    }

    private func performNetworkPush(request: URLRequest) async -> Bool {
        #if canImport(UIKit)
        var backgroundTaskID = UIBackgroundTaskIdentifier.invalid
        backgroundTaskID = UIApplication.shared.beginBackgroundTask {
            if backgroundTaskID != .invalid {
                UIApplication.shared.endBackgroundTask(backgroundTaskID)
                backgroundTaskID = .invalid
            }
        }
        defer {
            if backgroundTaskID != .invalid {
                UIApplication.shared.endBackgroundTask(backgroundTaskID)
            }
        }
        #endif

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                lastPushError = "Push failed (HTTP \(code))."
                return false
            }
            return true
        } catch {
            lastPushError = error.localizedDescription
            log.error("bridge push failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    private struct IngestPayload: Encodable {
        struct Battery: Encodable {
            let base: Int?
            let probe: Int?
        }

        let device: String
        let tempF: Double?
        let targetF: Double
        let battery: Battery
        let connected: Bool
        let ts: Int
    }
}

import Foundation
import os
#if canImport(UIKit)
import UIKit
#endif

/// When linked, POST multi-probe readings to the relay so your OpenClaw can watch the cook.
///
/// BLE-driven (NOT a wall-clock timer): ThermometerManager pokes `onStateChange`
/// on every reading and connection change.
///
/// Cadence: throttled to ~every 20s; immediate when any probe newly reaches target;
/// one final push when all probes disconnect. No-ops when unlinked.
@MainActor
final class BridgeClient: ObservableObject {
    @Published private(set) var lastPushAt: Date?
    @Published private(set) var lastPushError: String?

    private let thermo: ThermometerManager
    private let log = Logger(subsystem: "com.bbqlaw.app", category: "bridge")
    private var reachedProbeIds: Set<UUID> = []
    private var targetPushInFlight = false
    private var wasAnyConnected = false
    private var lastAttemptAt: Date?
    private var consecutiveFailures = 0
    private let pushInterval: TimeInterval = 20

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

    func pushNow() {
        Task { await pushReading(kind: .forced) }
    }

    private var anyConnected: Bool { thermo.anyConnected }

    private func onThermoUpdate() {
        guard BridgeKeychain.isLinked else { return }

        if !anyConnected {
            if wasAnyConnected {
                wasAnyConnected = false
                reachedProbeIds.removeAll()
                targetPushInFlight = false
                Task { await pushReading(kind: .disconnect) }
            }
            return
        }
        wasAnyConnected = true

        let newlyReached = thermo.probes.filter { $0.isReached && !reachedProbeIds.contains($0.id) }
        if let probe = newlyReached.first, !targetPushInFlight {
            targetPushInFlight = true
            Task { await pushReading(kind: .target, markReached: probe.id) }
            return
        }
        if targetPushInFlight { return }

        for probe in thermo.probes where !probe.isReached {
            reachedProbeIds.remove(probe.id)
        }

        let effectiveInterval = pushInterval * Double(1 + min(consecutiveFailures, 5))
        if let last = lastAttemptAt, Date().timeIntervalSince(last) < effectiveInterval - 1 { return }
        Task { await pushReading(kind: .heartbeat) }
    }

    private func pushReading(kind: PushKind, markReached: UUID? = nil) async {
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
            ts: Int(Date().timeIntervalSince1970),
            probes: thermo.probes.map { probePayload($0) }
        )

        var request = URLRequest(url: creds.ingestURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(creds.deviceToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONEncoder().encode(payload)

        let succeeded = await performNetworkPush(request: request)

        if succeeded {
            lastPushAt = Date()
            lastPushError = nil
            consecutiveFailures = 0
            if kind == .target, let id = markReached {
                reachedProbeIds.insert(id)
                targetPushInFlight = false
            }
        } else {
            consecutiveFailures += 1
            if kind == .target {
                targetPushInFlight = false
            }
        }
    }

    private func probePayload(_ probe: Probe) -> IngestProbe {
        IngestProbe(
            id: probe.id.uuidString,
            name: probe.name,
            color: probe.colorHexString,
            tempF: probe.connection == .connected ? probe.tempF : nil,
            targetF: probe.targetF,
            meat: meat(forKey: probe.meatKey)?.name,
            doneness: probe.doneness,
            mode: probe.mode.rawValue,
            probeBattery: probe.probeBattery,
            baseBattery: probe.baseBattery,
            connected: probe.connection == .connected
        )
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
        let device: String
        let ts: Int
        let probes: [IngestProbe]
    }

    private struct IngestProbe: Encodable {
        let id: String
        let name: String
        let color: String
        let tempF: Double?
        let targetF: Double?
        let meat: String?
        let doneness: String?
        let mode: String
        let probeBattery: Int?
        let baseBattery: Int?
        let connected: Bool
    }
}

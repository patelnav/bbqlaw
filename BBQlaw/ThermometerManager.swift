import Foundation
import CoreBluetooth
import UserNotifications
import os
#if canImport(UIKit)
import UIKit
#endif

/// Per-peripheral transient BLE state (not published — the display half lives in `Probe`).
final class ProbeSession {
    let peripheral: CBPeripheral
    var controlCharacteristic: CBCharacteristic?   // FF02
    var pendingNotify: Set<CBUUID> = []
    var authAttempts = 0
    var challengeSeen = false
    var userInitiatedDisconnect = false
    init(peripheral: CBPeripheral) { self.peripheral = peripheral }
}

/// Multi-probe central BLE manager for INT-11I-B class thermometers.
///
/// Each connected thermometer is one CBPeripheral with its own auth handshake,
/// temperature stream, batteries, name, and target — tracked as a `Probe` in the
/// published `probes` array (keyed by peripheral identifier) plus a `ProbeSession`
/// holding transient handshake state.
///
/// Background continuity for long cooks comes from CoreBluetooth state restoration
/// + connect()-based auto-reconnect (background scanning is ignored by iOS), per
/// peripheral.
final class ThermometerManager: NSObject, ObservableObject {

    private enum Keys {
        static let cooks = "bbqlaw.cooks.v2"   // [uuidString: PersistedCook]
    }
    private static let restoreIdentifier = "com.bbqlaw.central"

    // MARK: Published state
    @Published var probes: [Probe] = []
    @Published var discovered: [DiscoveredDevice] = []
    @Published var bluetoothOff = false
    @Published var scanning = false
    @Published var lastError: String?

    /// Fired on each reading / connection change so the OpenClaw bridge can push
    /// from the BLE path (works backgrounded, unlike a wall-clock timer).
    var onStateChange: (() -> Void)?

    // MARK: Internals
    private let defaults = UserDefaults.standard
    private let log = Logger(subsystem: "com.bbqlaw.app", category: "ble")
    private var central: CBCentralManager!
    private var sessions: [UUID: ProbeSession] = [:]
    private var persisted: [String: PersistedCook] = [:]

    override init() {
        super.init()
        loadCooks()
        central = CBCentralManager(delegate: self, queue: nil, options: [
            CBCentralManagerOptionRestoreIdentifierKey: ThermometerManager.restoreIdentifier
        ])
    }

    // MARK: Derived
    var connectedCount: Int { probes.filter { $0.connection == .connected }.count }
    var anyConnected: Bool { connectedCount > 0 }

    // MARK: Public API
    func startScan() {
        guard central.state == .poweredOn else { return }
        discovered.removeAll()
        scanning = true
        // Foreground discovery is broad (services: nil): the advertised service UUID
        // isn't confirmed across INT variants. Background reconnection uses connect().
        central.scanForPeripherals(withServices: nil, options: [
            CBCentralManagerScanOptionAllowDuplicatesKey: false
        ])
    }

    func stopScan() {
        central.stopScan()
        scanning = false
    }

    /// Connect (add) a probe. Same path for the first probe and every subsequent one.
    func connect(_ device: DiscoveredDevice) {
        stopScan()
        let id = device.peripheral.identifier
        guard sessions[id] == nil else { return }   // already linked

        let session = ProbeSession(peripheral: device.peripheral)
        session.peripheral.delegate = self
        sessions[id] = session

        if let idx = probes.firstIndex(where: { $0.id == id }) {
            probes[idx].connection = .connecting
            probes[idx].advertisedName = device.name
        } else {
            probes.append(makeProbe(id: id, advertisedName: device.name))
        }
        central.connect(device.peripheral, options: nil)
    }

    /// Remove a probe entirely (user-initiated): disconnect + forget.
    func removeProbe(_ id: UUID) {
        if let session = sessions[id] {
            session.userInitiatedDisconnect = true
            central.cancelPeripheralConnection(session.peripheral)
            session.peripheral.delegate = nil
        }
        sessions[id] = nil
        probes.removeAll { $0.id == id }
        persisted[id.uuidString] = nil
        persistCooks()
        onStateChange?()
    }

    // MARK: Cook mutators (persist per-probe so a reconnect restores the cook)
    func setName(_ id: UUID, _ name: String) {
        mutate(id) { $0.name = name }; saveCook(id); onStateChange?()
    }

    func setTarget(_ id: UUID, _ targetF: Double?) {
        mutate(id) { p in
            p.targetF = targetF
            guard let target = targetF, let temp = p.tempF, p.mode == .live else {
                p.targetReached = false
                p.hasFiredAlarm = false
                return
            }
            if target <= temp {
                p.targetReached = true
                p.hasFiredAlarm = true
            } else {
                p.targetReached = false
                p.hasFiredAlarm = false
            }
        }
        saveCook(id); onStateChange?()
    }

    /// Apply a meat/doneness selection (and its preset target, unless nil/custom).
    func setCook(_ id: UUID, meatKey: String?, doneness: String?, target: Double?) {
        mutate(id) { p in
            p.meatKey = meatKey
            p.doneness = doneness
            if let target { p.targetF = target; p.hasFiredAlarm = false; p.targetReached = false }
        }
        evaluateAlarm(id); saveCook(id); onStateChange?()
    }

    // MARK: Helpers
    private func mutate(_ id: UUID, _ block: (inout Probe) -> Void) {
        guard let idx = probes.firstIndex(where: { $0.id == id }) else { return }
        block(&probes[idx])
    }

    private func makeProbe(id: UUID, advertisedName: String?) -> Probe {
        if let saved = persisted[id.uuidString] {
            return Probe(id: id, name: saved.name, colorHex: saved.colorHex,
                         meatKey: saved.meatKey, doneness: saved.doneness, targetF: saved.targetF,
                         connection: .connecting, advertisedName: advertisedName)
        }
        let index = probes.count
        let colorHex = BBQ.probeColorsHex[index % BBQ.probeColorsHex.count]
        return Probe(id: id, name: "Probe \(index + 1)", colorHex: colorHex,
                     connection: .connecting, advertisedName: advertisedName)
    }

    private func attemptReconnect(_ id: UUID) {
        guard let session = sessions[id], !session.userInitiatedDisconnect else { return }
        mutate(id) { $0.connection = .connecting }
        central.connect(session.peripheral, options: nil)   // patient, background-honored
    }

    private func resetReadings(_ id: UUID) {
        mutate(id) { p in
            p.tempF = nil
            p.mode = .noReading
            p.targetReached = false
            p.readingNote = nil
            p.authState = .none
            // hasFiredAlarm persists across reconnects (hysteresis re-arms it).
        }
        if let session = sessions[id] {
            session.controlCharacteristic = nil
            session.pendingNotify.removeAll()
            session.authAttempts = 0
            session.challengeSeen = false
        }
    }

    // MARK: Auth (keeps each probe streaming with no vendor app)
    private func startAuth(_ id: UUID) {
        guard let session = sessions[id], let ctrl = session.controlCharacteristic else { return }
        session.authAttempts += 1
        let attempt = session.authAttempts
        mutate(id) { $0.authState = .requested }
        log.notice("auth[\(id.uuidString, privacy: .public)]: -> 01 fb (attempt \(attempt))")
        session.peripheral.writeValue(Data([0x01, 0xFB]), for: ctrl, type: .withoutResponse)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            guard let self, let session = self.sessions[id] else { return }
            let probe = self.probes.first { $0.id == id }
            guard probe?.connection == .connected, !session.challengeSeen,
                  probe?.authState == .requested, attempt == session.authAttempts else { return }
            if attempt < 5 {
                self.startAuth(id)
            } else {
                self.log.notice("auth[\(id.uuidString, privacy: .public)]: no challenge — waiting for probe")
                self.mutate(id) { $0.authState = .waiting }
            }
        }
    }

    private func handleControlFrames(_ id: UUID, _ data: Data) {
        guard let session = sessions[id], let ctrl = session.controlCharacteristic else { return }
        let authed = probes.first { $0.id == id }?.authState == .authed
        for (type, body) in parseControlFrames(data) {
            switch type {
            case 0xFB where body.count >= 6 && !session.challengeSeen && !authed:
                session.challengeSeen = true
                let challenge = Array(body.prefix(6))
                let resp = buildAuthResponse(challenge: challenge)
                log.notice("auth[\(id.uuidString, privacy: .public)]: <- challenge; -> verify")
                session.peripheral.writeValue(resp, for: ctrl, type: .withoutResponse)
            case 0xFC where !authed:
                if body.first == 0 {
                    mutate(id) { $0.authState = .authed }
                    lastError = nil
                } else {
                    mutate(id) { $0.authState = .failed }
                    lastError = "auth rejected (status \(body.first ?? 0xFF))"
                }
            default:
                break
            }
        }
    }

    // MARK: Alarm (per probe)
    private func evaluateAlarm(_ id: UUID) {
        guard let idx = probes.firstIndex(where: { $0.id == id }) else { return }
        var p = probes[idx]
        guard let t = p.targetF, let temp = p.tempF, p.mode == .live else { return }
        if temp >= t {
            p.targetReached = true
            if !p.hasFiredAlarm {
                p.hasFiredAlarm = true
                fireTargetNotification(name: p.name, current: temp, target: t)
            }
        } else if temp < t - 2 {
            p.targetReached = false
            p.hasFiredAlarm = false
        }
        probes[idx] = p
    }

    private func fireTargetNotification(name: String, current: Double, target: Double) {
        let content = UNMutableNotificationContent()
        content.title = "🔥 \(name) hit target"
        content.body = String(format: "%@ reached %.0f°F (target %.0f°F).", name, current, target)
        content.sound = .default
        let req = UNNotificationRequest(identifier: "bbqlaw.target.\(name)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
        #if canImport(UIKit)
        // Haptic on the rising edge (no-op when backgrounded).
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        #endif
    }

    // MARK: Persistence
    private struct PersistedCook: Codable {
        var name: String
        var colorHex: UInt32
        var meatKey: String?
        var doneness: String?
        var targetF: Double?
    }

    private func loadCooks() {
        guard let data = defaults.data(forKey: Keys.cooks),
              let map = try? JSONDecoder().decode([String: PersistedCook].self, from: data) else { return }
        persisted = map
    }

    private func saveCook(_ id: UUID) {
        guard let p = probes.first(where: { $0.id == id }) else { return }
        persisted[id.uuidString] = PersistedCook(
            name: p.name, colorHex: p.colorHex, meatKey: p.meatKey,
            doneness: p.doneness, targetF: p.targetF
        )
        persistCooks()
    }

    private func persistCooks() {
        if let data = try? JSONEncoder().encode(persisted) {
            defaults.set(data, forKey: Keys.cooks)
        }
    }
}

// MARK: - CBCentralManagerDelegate
extension ThermometerManager: CBCentralManagerDelegate {
    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        guard let restored = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] else { return }
        for p in restored {
            let id = p.identifier
            if sessions[id] == nil {
                let session = ProbeSession(peripheral: p)
                p.delegate = self
                sessions[id] = session
            }
            if probes.firstIndex(where: { $0.id == id }) == nil {
                probes.append(makeProbe(id: id, advertisedName: p.name))
            }
            mutate(id) { $0.connection = p.state == .connected ? .connected : .connecting }
            if p.state == .connected { p.discoverServices(nil) }
        }
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            bluetoothOff = false
            // Resume any interrupted sessions.
            for (id, session) in sessions where session.peripheral.state != .connected && !session.userInitiatedDisconnect {
                attemptReconnect(id)
            }
        case .poweredOff, .unauthorized, .unsupported, .resetting, .unknown:
            bluetoothOff = true
            scanning = false
            for id in probes.map(\.id) { resetReadings(id); mutate(id) { $0.connection = .disconnected } }
        @unknown default:
            bluetoothOff = true
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let advName = (advertisementData[CBAdvertisementDataLocalNameKey] as? String)
            ?? peripheral.name ?? "Unknown"
        let advServices = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []
        let device = DiscoveredDevice(id: peripheral.identifier, peripheral: peripheral,
                                      name: advName, rssi: RSSI.intValue, services: advServices)
        // Hide probes we're already connected to.
        if probes.contains(where: { $0.id == device.id && $0.connection == .connected }) { return }
        if let idx = discovered.firstIndex(where: { $0.id == device.id }) {
            discovered[idx] = device
        } else {
            discovered.append(device)
        }
        discovered.sort {
            $0.looksLikeThermometer != $1.looksLikeThermometer
                ? $0.looksLikeThermometer
                : $0.rssi > $1.rssi
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        let id = peripheral.identifier
        guard sessions[id] != nil else {
            // Probe was removed during the connect window — don't resurrect it.
            central.cancelPeripheralConnection(peripheral)
            return
        }
        sessions[id]?.userInitiatedDisconnect = false
        mutate(id) { $0.connection = .connected }
        lastError = nil
        log.notice("connected \(id.uuidString, privacy: .public); discovering services")
        peripheral.discoverServices(nil)
        onStateChange?()
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        lastError = error?.localizedDescription ?? "Connection failed"
        attemptReconnect(peripheral.identifier)
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        let id = peripheral.identifier
        if let error { lastError = error.localizedDescription }
        let userInitiated = sessions[id]?.userInitiatedDisconnect ?? true
        log.notice("disconnected \(id.uuidString, privacy: .public) (userInitiated=\(userInitiated))")
        resetReadings(id)
        if userInitiated {
            mutate(id) { $0.connection = .disconnected }
        } else {
            attemptReconnect(id)   // unexpected drop mid-cook — keep trying
        }
        onStateChange?()
    }
}

// MARK: - CBPeripheralDelegate
extension ThermometerManager: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error { lastError = error.localizedDescription; return }
        for service in peripheral.services ?? [] {
            peripheral.discoverCharacteristics(nil, for: service)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        if let error { lastError = error.localizedDescription; return }
        guard service.uuid == ProbeGATT.service else { return }
        let id = peripheral.identifier
        guard let session = sessions[id] else { return }
        mutate(id) { $0.authState = .subscribing }
        // Subscribe ALL FF00-family notify chars BEFORE the auth hello — the probe
        // only emits the challenge once every one is subscribed.
        for ch in service.characteristics ?? [] {
            if ch.uuid == ProbeGATT.controlChar { session.controlCharacteristic = ch }
            if ProbeGATT.notifyChars.contains(ch.uuid), ch.properties.contains(.notify) {
                session.pendingNotify.insert(ch.uuid)
                peripheral.setNotifyValue(true, for: ch)
            }
            if ch.uuid == ProbeGATT.batteryChar, ch.properties.contains(.read) {
                peripheral.readValue(for: ch)
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        if let error { lastError = error.localizedDescription; return }
        let id = peripheral.identifier
        guard let session = sessions[id] else { return }
        session.pendingNotify.remove(characteristic.uuid)
        if session.pendingNotify.isEmpty, probes.first(where: { $0.id == id })?.authState == .subscribing {
            startAuth(id)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error { lastError = error.localizedDescription; return }
        guard let data = characteristic.value else { return }
        let id = peripheral.identifier
        switch characteristic.uuid {
        case ProbeGATT.tempChar:
            switch decodeProbeReading(data) {
            case .fahrenheit(let f):
                mutate(id) { p in
                    p.tempF = f; p.mode = .live; p.readingNote = nil
                    p.recentTemps.append(f)
                    if p.recentTemps.count > 60 {
                        p.recentTemps.removeFirst(p.recentTemps.count - 60)
                    }
                }
                evaluateAlarm(id)
            case .docked:
                mutate(id) { p in
                    p.tempF = nil; p.mode = .docked; p.targetReached = false
                    p.readingNote = (p.probeBattery ?? 0) >= 100 ? "Docked · battery full" : "Charging in base station"
                }
            case .noReading:
                mutate(id) { p in p.tempF = nil; p.mode = .noReading; p.targetReached = false; p.readingNote = "No probe reading" }
            }
            mutate(id) { $0.lastReadingAt = Date() }
            onStateChange?()
        case ProbeGATT.batteryChar:
            let (base, probe) = decodeBattery(data)
            mutate(id) { p in p.baseBattery = base; p.probeBattery = probe }
        case ProbeGATT.controlChar:
            handleControlFrames(id, data)
        default:
            break
        }
    }
}

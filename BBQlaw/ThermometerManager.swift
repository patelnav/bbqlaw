import Foundation
import CoreBluetooth
import UserNotifications
import os

/// Central BLE manager for the BLE meat thermometer (INT-11I-B class; likely siblings in the INT family).
///
/// Uses the main run loop as the delegate queue (queue: nil), so every delegate
/// callback lands on the main thread and can mutate @Published state directly.
///
/// Background continuity for long (multi-hour) cooks is handled by two things,
/// NOT by background scanning (which iOS silently ignores):
///   1. CoreBluetooth state restoration — iOS can relaunch BBQlaw into the
///      background and hand back the in-progress peripheral via willRestoreState.
///   2. connect()-based auto-reconnect — connect() has no timeout and is honored
///      in the background, so a range blip resumes automatically.
final class ThermometerManager: NSObject, ObservableObject {

    private enum Keys {
        static let targetF = "bbqlaw.targetF"
        static let alarmEnabled = "bbqlaw.alarmEnabled"
        static let hasFiredAlarm = "bbqlaw.hasFiredAlarm"
    }
    private static let restoreIdentifier = "com.bbqlaw.central"

    // MARK: Published state
    @Published var connection: ConnectionState = .idle
    @Published var discovered: [DiscoveredDevice] = []
    @Published var temperatureF: Double?
    @Published var probeBattery: Int?
    @Published var baseBattery: Int?
    @Published var lastRawTemp: Data?          // surfaced in the UI to confirm decoding on first connect
    @Published var connectedName: String?
    @Published var lastError: String?
    @Published var authState: AuthState = .none
    @Published var readingNote: String?        // shown under the temp when there's no live reading

    // MARK: Alarm (persisted so a mid-cook restart/reconnect doesn't re-fire)
    @Published var targetF: Double {
        didSet {
            defaults.set(targetF, forKey: Keys.targetF)
            // A new target re-arms the alarm and clears any prior "reached" state.
            hasFiredAlarm = false
            targetReached = false
        }
    }
    @Published var alarmEnabled: Bool {
        didSet { defaults.set(alarmEnabled, forKey: Keys.alarmEnabled) }
    }
    @Published var targetReached: Bool = false
    private var hasFiredAlarm: Bool {
        didSet { defaults.set(hasFiredAlarm, forKey: Keys.hasFiredAlarm) }
    }

    // MARK: BLE internals
    private let defaults = UserDefaults.standard
    private let log = Logger(subsystem: "com.bbqlaw.app", category: "ble")
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var userInitiatedDisconnect = false
    private var controlCharacteristic: CBCharacteristic?   // FF02
    private var pendingNotify: Set<CBUUID> = []             // chars awaiting notify-enable
    private var authAttempts = 0
    private var challengeSeen = false
    /// Fired on each reading / connection change so the OpenClaw bridge can push
    /// from the BLE path (works backgrounded, unlike a wall-clock timer).
    var onStateChange: (() -> Void)?

    override init() {
        targetF = defaults.object(forKey: Keys.targetF) as? Double ?? 203  // brisket / pulled-pork default
        alarmEnabled = defaults.object(forKey: Keys.alarmEnabled) as? Bool ?? true
        hasFiredAlarm = defaults.bool(forKey: Keys.hasFiredAlarm)
        super.init()
        central = CBCentralManager(delegate: self, queue: nil, options: [
            CBCentralManagerOptionRestoreIdentifierKey: ThermometerManager.restoreIdentifier
        ])
    }

    // MARK: Public API
    func startScan() {
        guard central.state == .poweredOn else { return }
        discovered.removeAll()
        connection = .scanning
        // Foreground discovery is intentionally broad (services: nil) because the
        // advertised service UUID isn't yet confirmed across INT variants. This is
        // a foreground-only path; background reconnection uses connect(), above.
        central.scanForPeripherals(withServices: nil, options: [
            CBCentralManagerScanOptionAllowDuplicatesKey: false
        ])
    }

    func stopScan() {
        central.stopScan()
        if connection == .scanning { connection = .idle }
    }

    func connect(_ device: DiscoveredDevice) {
        stopScan()
        userInitiatedDisconnect = false
        connection = .connecting
        peripheral = device.peripheral
        peripheral?.delegate = self
        connectedName = device.name
        central.connect(device.peripheral, options: nil)
    }

    func disconnect() {
        userInitiatedDisconnect = true
        if let p = peripheral { central.cancelPeripheralConnection(p) }
    }

    // MARK: Helpers
    private func attemptReconnect() {
        guard let p = peripheral, !userInitiatedDisconnect else { return }
        connection = .connecting
        central.connect(p, options: nil)   // patient, background-honored reconnect
    }

    private func resetReadings() {
        temperatureF = nil
        probeBattery = nil
        baseBattery = nil
        lastRawTemp = nil
        targetReached = false
        readingNote = nil
        authState = .none
        controlCharacteristic = nil
        pendingNotify.removeAll()
        authAttempts = 0
        challengeSeen = false
        // Deliberately NOT resetting hasFiredAlarm: it persists across reconnects
        // and restarts so a mid-cook blip doesn't re-fire the alert. The hysteresis
        // in evaluateAlarm() re-arms it once the temp drops well below target.
    }

    /// FF02 auth handshake: request a challenge, retrying because the probe only
    /// issues one when it's actively measuring (silent while docked/idle).
    private func startAuth() {
        guard let ctrl = controlCharacteristic, let p = peripheral else { return }
        authAttempts += 1
        let attempt = authAttempts
        authState = .requested
        log.notice("auth: -> 01 fb (attempt \(attempt))")
        p.writeValue(Data([0x01, 0xFB]), for: ctrl, type: .withoutResponse)  // request challenge
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            guard let self else { return }
            // Only act if this is still the latest attempt, no challenge arrived,
            // we're still connected, and we haven't authed.
            guard self.connection == .connected, !self.challengeSeen,
                  self.authState == .requested, attempt == self.authAttempts else { return }
            if attempt < 5 {
                self.startAuth()
            } else {
                // Probe isn't answering — almost always because it's docked/idle.
                // Stay connected; a reconnect re-attempts auth once it's active.
                self.log.notice("auth: no challenge after \(attempt) tries — waiting for probe")
                self.authState = .waiting
            }
        }
    }

    /// Handle FF02 control frames: answer the challenge, record the auth result.
    private func handleControlFrames(_ data: Data) {
        guard let ctrl = controlCharacteristic, let p = peripheral else { return }
        for (type, body) in parseControlFrames(data) {
            switch type {
            case 0xFB where body.count >= 6 && !challengeSeen && authState != .authed:
                // Answer ONLY the first challenge per connection. Responding to a
                // second (from a retried 01 fb) sends a stale verify the device
                // rejects, which used to flip a good auth to "failed".
                challengeSeen = true
                let challenge = Array(body.prefix(6))
                let resp = buildAuthResponse(challenge: challenge)
                log.notice("auth: <- 07 fb challenge \(challenge.map { String(format: "%02x", $0) }.joined()); -> 08 fc verify")
                p.writeValue(resp, for: ctrl, type: .withoutResponse)
            case 0xFC where authState != .authed:   // 02 fc <status> -> auth result
                if body.first == 0 {
                    log.notice("auth: <- 02 fc 00  ACCEPTED")
                    authState = .authed
                    lastError = nil
                } else {
                    log.error("auth: <- 02 fc \(body.first ?? 0xFF, format: .hex)  REJECTED")
                    authState = .failed
                    lastError = "auth rejected (status \(body.first ?? 0xFF))"
                }
            default:
                break
            }
        }
    }

    private func evaluateAlarm() {
        guard alarmEnabled, let t = temperatureF else { return }
        if t >= targetF {
            targetReached = true
            if !hasFiredAlarm {
                hasFiredAlarm = true
                fireTargetNotification(current: t)
            }
        } else if t < targetF - 2 {
            targetReached = false
            hasFiredAlarm = false
        }
    }

    private func fireTargetNotification(current: Double) {
        let content = UNMutableNotificationContent()
        content.title = "🔥 Target reached"
        content.body = String(format: "Your food hit %.0f°F (target %.0f°F).", current, targetF)
        content.sound = .default
        let req = UNNotificationRequest(identifier: "bbqlaw.target", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }
}

// MARK: - CBCentralManagerDelegate
extension ThermometerManager: CBCentralManagerDelegate {
    func centralManager(_ central: CBCentralManager,
                        willRestoreState dict: [String: Any]) {
        // iOS relaunched us (likely into the background) with an in-progress session.
        guard let restored = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral],
              let p = restored.first else { return }
        peripheral = p
        p.delegate = self
        connectedName = p.name
        if p.state == .connected {
            connection = .connected
            p.discoverServices(nil)
        } else {
            connection = .connecting
        }
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            // Resume an interrupted session (e.g. after Bluetooth was toggled).
            if let p = peripheral, p.state != .connected, !userInitiatedDisconnect {
                attemptReconnect()
            } else if connection == .bluetoothOff {
                connection = .idle
            }
            if peripheral == nil { connection = .idle }
        case .poweredOff, .unauthorized, .unsupported, .resetting, .unknown:
            connection = .bluetoothOff
            resetReadings()
        @unknown default:
            connection = .bluetoothOff
        }
    }

    func centralManager(_ central: CBCentralManager,
                        didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any],
                        rssi RSSI: NSNumber) {
        let advName = (advertisementData[CBAdvertisementDataLocalNameKey] as? String)
            ?? peripheral.name ?? "Unknown"
        let advServices = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []
        let device = DiscoveredDevice(id: peripheral.identifier,
                                      peripheral: peripheral,
                                      name: advName,
                                      rssi: RSSI.intValue,
                                      services: advServices)
        if let idx = discovered.firstIndex(where: { $0.id == device.id }) {
            discovered[idx] = device
        } else {
            discovered.append(device)
        }
        discovered.sort {
            if $0.looksLikeThermometer != $1.looksLikeThermometer {
                return $0.looksLikeThermometer
            }
            return $0.rssi > $1.rssi
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        userInitiatedDisconnect = false
        connection = .connected
        lastError = nil
        log.notice("connected; discovering services")
        peripheral.discoverServices(nil)
        onStateChange?()
    }

    func centralManager(_ central: CBCentralManager,
                        didFailToConnect peripheral: CBPeripheral,
                        error: Error?) {
        lastError = error?.localizedDescription ?? "Connection failed"
        attemptReconnect()
    }

    func centralManager(_ central: CBCentralManager,
                        didDisconnectPeripheral peripheral: CBPeripheral,
                        error: Error?) {
        if let error { lastError = error.localizedDescription }
        log.notice("disconnected (userInitiated=\(self.userInitiatedDisconnect))")
        resetReadings()
        if userInitiatedDisconnect {
            connection = .disconnected
            peripheral.delegate = nil
            self.peripheral = nil
        } else {
            // Unexpected drop during a cook — keep trying to come back.
            attemptReconnect()
        }
        onStateChange?()   // let the bridge send a final connected:false
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

    func peripheral(_ peripheral: CBPeripheral,
                    didDiscoverCharacteristicsFor service: CBService,
                    error: Error?) {
        if let error { lastError = error.localizedDescription; return }
        guard service.uuid == ProbeGATT.service else { return }
        authState = .subscribing
        // Subscribe ALL FF00-family notify chars BEFORE the auth hello — the probe
        // only emits the challenge once every one is subscribed. startAuth() fires
        // from didUpdateNotificationStateFor once pendingNotify drains.
        for ch in service.characteristics ?? [] {
            if ch.uuid == ProbeGATT.controlChar {
                controlCharacteristic = ch
            }
            if ProbeGATT.notifyChars.contains(ch.uuid), ch.properties.contains(.notify) {
                pendingNotify.insert(ch.uuid)
                peripheral.setNotifyValue(true, for: ch)
            }
            if ch.uuid == ProbeGATT.batteryChar, ch.properties.contains(.read) {
                peripheral.readValue(for: ch)
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral,
                    didUpdateNotificationStateFor characteristic: CBCharacteristic,
                    error: Error?) {
        if let error { lastError = error.localizedDescription; return }
        pendingNotify.remove(characteristic.uuid)
        if pendingNotify.isEmpty && authState == .subscribing {
            startAuth()
        }
    }

    func peripheral(_ peripheral: CBPeripheral,
                    didUpdateValueFor characteristic: CBCharacteristic,
                    error: Error?) {
        if let error { lastError = error.localizedDescription; return }
        guard let data = characteristic.value else { return }
        switch characteristic.uuid {
        case ProbeGATT.tempChar:
            lastRawTemp = data
            switch decodeProbeReading(data) {
            case .fahrenheit(let f):
                temperatureF = f
                readingNote = nil
                evaluateAlarm()
            case .docked:
                temperatureF = nil
                targetReached = false    // clear stale "reached" state
                // Docked = sitting on the charger; use probe battery to distinguish.
                readingNote = (probeBattery ?? 0) >= 100 ? "Docked · battery full" : "Charging in base station"
            case .noReading:
                temperatureF = nil
                targetReached = false
                readingNote = "No probe reading"
            }
            onStateChange?()   // BLE-driven: poke the bridge on every reading
        case ProbeGATT.batteryChar:
            let (base, probe) = decodeBattery(data)
            baseBattery = base
            probeBattery = probe
        case ProbeGATT.controlChar:
            handleControlFrames(data)
        default:
            break
        }
    }
}

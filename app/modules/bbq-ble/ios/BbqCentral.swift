import CoreBluetooth
import ExpoModulesCore
import UIKit
import UserNotifications
import os

/// The one CoreBluetooth central. It has no thermometer knowledge.
/// Everything here runs on the main queue.
final class BbqCentral: NSObject {
  static let shared = BbqCentral()

  private static let restoreIdentifier = "app.bbqlaw.ios.central"
  private static let restoreHintKey = "bbqlaw.restoreHint"
  private static let restoreNotificationId = "bbqlaw.restore"
  private static let defaultRestoreHint = "Your cook is no longer being watched."
  private static let eventQueueCap = 2000
  private static let backgroundTail: TimeInterval = 10
  private static let backgroundCap: TimeInterval = 25

  private let log = Logger(subsystem: "app.bbqlaw.ios", category: "ble")
  private var central: CBCentralManager?
  /// Every peripheral seen or restored. CoreBluetooth needs a strong reference.
  private var peripherals: [UUID: CBPeripheral] = [:]
  private var advertisements: [UUID: Advertisement] = [:]
  private(set) var restoredIds: [String] = []

  private var sink: ((String, [String: Any?]) -> Void)?
  private var queuedEvents: [(String, [String: Any?])] = []
  private var listenerEverAttached = false
  private var restoreCheckScheduled = false

  private struct Key: Hashable {
    let peripheral: UUID
    let characteristic: ObjectIdentifier
  }
  private var pendingDiscover: [UUID: [Promise]] = [:]
  private var pendingServices: [UUID: Set<ObjectIdentifier>] = [:]
  private var pendingNotify: [Key: [Promise]] = [:]
  private var pendingRead: [Key: [Promise]] = [:]
  private var pendingWrite: [Key: [Promise]] = [:]

  // The 10 s tail after a background BLE callback, with its 25 s cap.
  private let callbackTask = BbqBackgroundTask(name: "bbqlaw.ble")
  private var callbackTaskStarted = Date.distantPast
  // The task JS controls.
  private let jsTask = BbqBackgroundTask(name: "bbqlaw.js")

  private struct Advertisement {
    var name: String?
    var services: [String] = []
    var manufacturerData: Data?
    var serviceData: [String: String] = [:]
  }

  func start() {
    guard central == nil else { return }
    central = CBCentralManager(delegate: self, queue: .main, options: [
      CBCentralManagerOptionRestoreIdentifierKey: BbqCentral.restoreIdentifier
    ])
  }

  // MARK: JS attachment

  func attach(_ sink: @escaping (String, [String: Any?]) -> Void) {
    start()
    self.sink = sink
    listenerEverAttached = true
    UNUserNotificationCenter.current()
      .removeDeliveredNotifications(withIdentifiers: [BbqCentral.restoreNotificationId])
    let queued = queuedEvents
    queuedEvents.removeAll()
    queued.forEach { sink($0.0, $0.1) }
  }

  func detach() {
    sink = nil
  }

  private func emit(_ name: String, _ body: [String: Any?]) {
    if let sink {
      sink(name, body)
    } else if queuedEvents.count < BbqCentral.eventQueueCap {
      queuedEvents.append((name, body))
    }
  }

  // MARK: Background time

  private func keepAwake() {
    guard UIApplication.shared.applicationState == .background else { return }
    if !callbackTask.isActive {
      callbackTask.begin()
      callbackTaskStarted = Date()
    }
    let remaining = BbqCentral.backgroundCap - Date().timeIntervalSince(callbackTaskStarted)
    callbackTask.end(after: max(0, min(BbqCentral.backgroundTail, remaining)))
  }

  func beginBackgroundWork(ms: Double) {
    let seconds = ms.isFinite ? min(max(ms / 1000, 0), BbqCentral.backgroundCap) : BbqCentral.backgroundCap
    jsTask.begin()
    jsTask.end(after: seconds)
  }

  func endBackgroundWork() {
    jsTask.end()
  }

  // MARK: Restore hint

  func setRestoreHint(_ text: String) {
    UserDefaults.standard.set(text, forKey: BbqCentral.restoreHintKey)
  }

  /// iOS restored us, but React Native did not start (spec §4.3).
  private func scheduleRestoreCheck() {
    guard !restoreCheckScheduled else { return }
    restoreCheckScheduled = true
    let task = BbqBackgroundTask(name: "bbqlaw.restore")
    task.begin()
    task.end(after: 8)
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
      guard let self, !self.listenerEverAttached else {
        task.end()
        return
      }
      let content = UNMutableNotificationContent()
      content.title = "Open BBQlaw to keep watching"
      let hint = UserDefaults.standard.string(forKey: BbqCentral.restoreHintKey) ?? ""
      content.body = hint.isEmpty ? BbqCentral.defaultRestoreHint : hint
      content.sound = .default
      let request = UNNotificationRequest(
        identifier: BbqCentral.restoreNotificationId, content: content, trigger: nil)
      UNUserNotificationCenter.current().add(request) { _ in
        DispatchQueue.main.async { task.end() }
      }
    }
  }

  // MARK: API

  var stateName: String {
    switch central?.state ?? .unknown {
    case .poweredOn: return "poweredOn"
    case .poweredOff: return "poweredOff"
    case .unauthorized: return "unauthorized"
    case .unsupported: return "unsupported"
    case .resetting: return "resetting"
    case .unknown: return "unknown"
    @unknown default: return "unknown"
    }
  }

  private var isPoweredOn: Bool { central?.state == .poweredOn }

  func startScan() {
    guard isPoweredOn else { return }
    advertisements.removeAll()
    central?.scanForPeripherals(withServices: nil, options: [
      CBCentralManagerScanOptionAllowDuplicatesKey: false
    ])
  }

  func stopScan() {
    guard isPoweredOn else { return }
    central?.stopScan()
  }

  private func peripheral(for id: String) -> CBPeripheral? {
    guard let uuid = UUID(uuidString: id) else { return nil }
    if let known = peripherals[uuid] { return known }
    guard let found = central?.retrievePeripherals(withIdentifiers: [uuid]).first else { return nil }
    retain(found)
    return found
  }

  private func retain(_ peripheral: CBPeripheral) {
    peripheral.delegate = self
    peripherals[peripheral.identifier] = peripheral
  }

  func connect(_ id: String, _ promise: Promise) {
    guard isPoweredOn else {
      reject(promise, "bluetooth_\(stateName)")
      return
    }
    guard let target = peripheral(for: id) else {
      reject(promise, "unknown_peripheral")
      return
    }
    target.delegate = self
    if target.state == .connected {
      emit("connected", ["id": target.identifier.uuidString])
    } else {
      central?.connect(target, options: nil)  // pending until it succeeds or is cancelled
    }
    promise.resolve(nil)
  }

  func cancel(_ id: String) {
    guard isPoweredOn, let target = peripheral(for: id) else { return }
    central?.cancelPeripheralConnection(target)
    // A pending connection gets no disconnect callback.
    if target.state != .connected {
      failPending(target.identifier, "disconnected")
    }
  }

  func discover(_ id: String, _ promise: Promise) {
    guard let target = peripheral(for: id), target.state == .connected else {
      reject(promise, "disconnected")
      return
    }
    let key = target.identifier
    let inFlight = pendingDiscover[key] != nil
    pendingDiscover[key, default: []].append(promise)
    if !inFlight { target.discoverServices(nil) }
  }

  private enum Lookup {
    case found(CBPeripheral, CBCharacteristic)
    case failure(String)
  }

  private func lookup(_ id: String, _ service: String?, _ char: String) -> Lookup {
    guard let charUUID = BbqUUID.make(char) else { return .failure("invalid_uuid") }
    var serviceUUID: CBUUID?
    if let service {
      guard let valid = BbqUUID.make(service) else { return .failure("invalid_uuid") }
      serviceUUID = valid
    }
    guard let target = peripheral(for: id), target.state == .connected else { return .failure("disconnected") }
    let wantedChar = BbqUUID.string(charUUID)
    let wantedService = serviceUUID.map(BbqUUID.string)
    let matches = (target.services ?? [])
      .filter { wantedService == nil || BbqUUID.string($0.uuid) == wantedService }
      .flatMap { $0.characteristics ?? [] }
      .filter { BbqUUID.string($0.uuid) == wantedChar }
    guard let first = matches.first else { return .failure("characteristic_not_found") }
    if matches.count > 1 && serviceUUID == nil { return .failure("ambiguous_characteristic") }
    return .found(target, first)
  }

  private func key(_ peripheral: CBPeripheral, _ characteristic: CBCharacteristic) -> Key {
    Key(peripheral: peripheral.identifier, characteristic: ObjectIdentifier(characteristic))
  }

  func setNotify(_ id: String, _ service: String?, _ char: String, _ on: Bool, _ promise: Promise) {
    switch lookup(id, service, char) {
    case .failure(let code):
      reject(promise, code)
    case let .found(target, characteristic):
      pendingNotify[key(target, characteristic), default: []].append(promise)
      target.setNotifyValue(on, for: characteristic)
    }
  }

  func read(_ id: String, _ service: String?, _ char: String, _ promise: Promise) {
    switch lookup(id, service, char) {
    case .failure(let code):
      reject(promise, code)
    case let .found(target, characteristic):
      pendingRead[key(target, characteristic), default: []].append(promise)
      target.readValue(for: characteristic)
    }
  }

  func write(_ id: String, _ service: String?, _ char: String, _ bytes: [Double],
             _ withResponse: Bool, _ promise: Promise) {
    var data = Data(capacity: bytes.count)
    for value in bytes {
      guard value.isFinite, value >= 0, value <= 255, value == value.rounded() else {
        reject(promise, "invalid_bytes")
        return
      }
      data.append(UInt8(value))
    }
    switch lookup(id, service, char) {
    case .failure(let code):
      reject(promise, code)
    case let .found(target, characteristic):
      if withResponse {
        pendingWrite[key(target, characteristic), default: []].append(promise)
        target.writeValue(data, for: characteristic, type: .withResponse)
      } else {
        target.writeValue(data, for: characteristic, type: .withoutResponse)
        promise.resolve(nil)
      }
    }
  }

  // MARK: Pending promises

  private func reject(_ promise: Promise, _ code: String, _ message: String? = nil) {
    promise.reject(code, message ?? code)
  }

  private func failPending(_ peripheral: UUID, _ code: String) {
    pendingServices[peripheral] = nil
    pendingDiscover.removeValue(forKey: peripheral)?.forEach { reject($0, code) }
    for key in pendingNotify.keys.filter({ $0.peripheral == peripheral }) {
      pendingNotify.removeValue(forKey: key)?.forEach { reject($0, code) }
    }
    for key in pendingRead.keys.filter({ $0.peripheral == peripheral }) {
      pendingRead.removeValue(forKey: key)?.forEach { reject($0, code) }
    }
    for key in pendingWrite.keys.filter({ $0.peripheral == peripheral }) {
      pendingWrite.removeValue(forKey: key)?.forEach { reject($0, code) }
    }
  }

  private func failAllPending(_ code: String) {
    var ids = Set(pendingDiscover.keys)
    ids.formUnion(pendingNotify.keys.map(\.peripheral))
    ids.formUnion(pendingRead.keys.map(\.peripheral))
    ids.formUnion(pendingWrite.keys.map(\.peripheral))
    ids.forEach { failPending($0, code) }
  }

  private func finishDiscover(_ peripheral: CBPeripheral) {
    let services: [[String: Any]] = (peripheral.services ?? []).map { service in
      [
        "service": BbqUUID.string(service.uuid),
        "chars": (service.characteristics ?? []).map { characteristic in
          ["uuid": BbqUUID.string(characteristic.uuid), "props": BbqCentral.props(characteristic.properties)]
        },
      ]
    }
    pendingServices[peripheral.identifier] = nil
    pendingDiscover.removeValue(forKey: peripheral.identifier)?.forEach { $0.resolve(services) }
  }

  private static func props(_ properties: CBCharacteristicProperties) -> [String] {
    var out: [String] = []
    if properties.contains(.read) { out.append("read") }
    if properties.contains(.write) { out.append("write") }
    if properties.contains(.writeWithoutResponse) { out.append("writeNoResponse") }
    if properties.contains(.notify) { out.append("notify") }
    if properties.contains(.indicate) { out.append("indicate") }
    return out
  }

  private static func hex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
  }
}

// MARK: - CBCentralManagerDelegate
extension BbqCentral: CBCentralManagerDelegate {
  func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
    keepAwake()
    let restored = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? []
    guard !restored.isEmpty else { return }
    restored.forEach(retain)
    restoredIds = restored.map(\.identifier.uuidString)
    emit("restored", ["ids": restoredIds])
    scheduleRestoreCheck()
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    keepAwake()
    if central.state != .poweredOn {
      failAllPending("bluetooth_\(stateName)")
    }
    emit("state", ["state": stateName])
  }

  func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                      advertisementData: [String: Any], rssi RSSI: NSNumber) {
    keepAwake()
    retain(peripheral)
    // Scan responses arrive separately: keep what we already know.
    var ad = advertisements[peripheral.identifier] ?? Advertisement()
    ad.name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? ad.name ?? peripheral.name
    if let services = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] {
      for uuid in services.map(BbqUUID.string) where !ad.services.contains(uuid) {
        ad.services.append(uuid)
      }
    }
    if let data = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data {
      ad.manufacturerData = data
    }
    if let data = advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data] {
      for (uuid, value) in data {
        ad.serviceData[BbqUUID.string(uuid)] = BbqCentral.hex(value)
      }
    }
    advertisements[peripheral.identifier] = ad
    emit("discovered", [
      "id": peripheral.identifier.uuidString,
      "name": ad.name,
      "rssi": RSSI.intValue,
      "services": ad.services,
      "manufacturerData": ad.manufacturerData.map(BbqCentral.hex),
      "serviceData": ad.serviceData,
    ])
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    keepAwake()
    retain(peripheral)
    emit("connected", ["id": peripheral.identifier.uuidString])
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    keepAwake()
    failPending(peripheral.identifier, "disconnected")
    emit("failedToConnect", [
      "id": peripheral.identifier.uuidString,
      "error": error?.localizedDescription ?? "Connection failed",
    ])
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    keepAwake()
    failPending(peripheral.identifier, "disconnected")
    emit("disconnected", ["id": peripheral.identifier.uuidString, "error": error?.localizedDescription])
  }
}

// MARK: - CBPeripheralDelegate
extension BbqCentral: CBPeripheralDelegate {
  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    keepAwake()
    let id = peripheral.identifier
    guard pendingDiscover[id] != nil else { return }
    if let error {
      pendingDiscover.removeValue(forKey: id)?.forEach {
        reject($0, "discover_failed", error.localizedDescription)
      }
      return
    }
    let services = peripheral.services ?? []
    guard !services.isEmpty else {
      finishDiscover(peripheral)
      return
    }
    pendingServices[id] = Set(services.map(ObjectIdentifier.init))
    services.forEach { peripheral.discoverCharacteristics(nil, for: $0) }
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    keepAwake()
    if let error {
      log.error("characteristic discovery \(BbqUUID.string(service.uuid), privacy: .public): \(error.localizedDescription, privacy: .public)")
    }
    let id = peripheral.identifier
    // The barrier: finish only after every service has reported, error or not.
    guard pendingServices[id]?.remove(ObjectIdentifier(service)) != nil else { return }
    if pendingServices[id]?.isEmpty == true { finishDiscover(peripheral) }
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    keepAwake()
    pendingNotify.removeValue(forKey: key(peripheral, characteristic))?.forEach { promise in
      if let error {
        reject(promise, "notify_failed", error.localizedDescription)
      } else {
        promise.resolve(nil)
      }
    }
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    keepAwake()
    let bytes = characteristic.value.map { [UInt8]($0).map(Int.init) }
    // A pending read takes the value first. Otherwise it is a notification.
    if var reads = pendingRead[key(peripheral, characteristic)], !reads.isEmpty {
      let promise = reads.removeFirst()
      pendingRead[key(peripheral, characteristic)] = reads.isEmpty ? nil : reads
      if let error {
        reject(promise, "read_failed", error.localizedDescription)
      } else {
        promise.resolve(bytes ?? [])
      }
      return
    }
    if let error {
      log.error("value: \(error.localizedDescription, privacy: .public)")
      return
    }
    guard let bytes, let service = characteristic.service else { return }
    emit("value", [
      "id": peripheral.identifier.uuidString,
      "service": BbqUUID.string(service.uuid),
      "char": BbqUUID.string(characteristic.uuid),
      "bytes": bytes,
      "t": (Date().timeIntervalSince1970 * 1000).rounded(),
    ])
  }

  func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
    keepAwake()
    let writeKey = key(peripheral, characteristic)
    guard var writes = pendingWrite[writeKey], !writes.isEmpty else { return }
    let promise = writes.removeFirst()
    pendingWrite[writeKey] = writes.isEmpty ? nil : writes
    if let error {
      reject(promise, "write_failed", error.localizedDescription)
    } else {
      promise.resolve(nil)
    }
  }
}

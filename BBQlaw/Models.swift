import Foundation
import CoreBluetooth

/// GATT identifiers for the BLE meat thermometer (INT-11I-B class), recovered from the Home Assistant
/// community ESPHome reverse-engineering effort.
///
///   service     FF00
///   temp char   FF01  (notify)  -> 2-byte little-endian, degF * 100
///   battery     2A19  (read)    -> [baseBattery%, probeBattery%]
///
/// Known gotcha: the probe sleeps ~10 min after the last "recipe" was set in the
/// official app. We still need to confirm (via PacketLogger) whether we can send
/// our own keep-awake/recipe write, or whether setting it once in the official
/// app is enough. Until then, set a target in the official app before using BBQlaw.
enum ProbeGATT {
    static let service = CBUUID(string: "FF00")
    static let tempChar = CBUUID(string: "FF01")      // temperature (notify)
    static let controlChar = CBUUID(string: "FF02")   // auth + control (write/notify)
    static let stateChar = CBUUID(string: "FF03")     // device / verify state
    static let ff04 = CBUUID(string: "FF04")
    static let ff05 = CBUUID(string: "FF05")
    static let ff06 = CBUUID(string: "FF06")
    static let batteryChar = CBUUID(string: "2A19")   // [base%, probe%]

    /// Every FF00-family notify characteristic. The probe only emits the auth
    /// challenge once ALL of these are subscribed, so we enable them all before
    /// sending the hello (this was the key reverse-engineering finding).
    static let notifyChars = [tempChar, controlChar, stateChar, ff04, ff05, ff06, batteryChar]

    /// Names we treat as "probably our thermometer" when surfacing scan results.
    static let nameHints = ["int", "ibbq", "ibt", "tps", "bbq"]
}

/// Why there's no temperature — drives friendly UI copy.
enum ProbeReading: Equatable {
    case fahrenheit(Double)
    case docked        // probe in the base / powered off (0x7FFE / 0x7FFF)
    case noReading     // no data (0x0000 / 0xFFFF) or too-short payload
}

/// Classify a raw FF01 notification (2-byte little-endian °F×100, + status byte).
func decodeProbeReading(_ data: Data) -> ProbeReading {
    guard data.count >= 2 else { return .noReading }
    let raw = UInt16(data[0]) | (UInt16(data[1]) << 8)
    switch raw {
    case 0x7FFE, 0x7FFF, 0x8000: return .docked   // documented sentinels: error / no-probe / low (327.7°F when docked/off)
    case 0x0000, 0xFFFF: return .noReading
    default: return .fahrenheit(Double(raw) / 100.0)
    }
}

/// Convenience: degrees Fahrenheit, or nil if there's no real reading.
func decodeTemperatureF(_ data: Data) -> Double? {
    if case .fahrenheit(let f) = decodeProbeReading(data) { return f }
    return nil
}

/// Decode the battery characteristic: byte 0 = base %, byte 1 = probe %.
/// A single-byte payload is interpreted as the base level (byte-0 ordering),
/// consistent with the documented layout rather than guessing it's the probe.
func decodeBattery(_ data: Data) -> (base: Int?, probe: Int?) {
    switch data.count {
    case 0: return (nil, nil)
    case 1: return (Int(data[0]), nil)
    default: return (Int(data[0]), Int(data[1]))
    }
}

func fahrenheitToCelsius(_ f: Double) -> Double { (f - 32.0) * 5.0 / 9.0 }

// MARK: - FF02 auth (keeps the probe streaming with no vendor app)

enum AuthState: Equatable {
    case none, subscribing, requested, waiting, authed, failed

    var label: String {
        switch self {
        case .none: return ""
        case .subscribing: return "subscribing"
        case .requested: return "authenticating"
        case .waiting: return "waiting for probe"
        case .authed: return "authenticated"
        case .failed: return "auth failed"
        }
    }
}

/// Non-reflected (MSB-first) CRC-8. Matches the vendor app's CrcCalculator and
/// the vendored probe_auth reference (which passes 17/17 captured vectors).
func crc8(_ data: [UInt8], poly: UInt8, initial: UInt8) -> UInt8 {
    var crc = initial
    for byte in data {
        crc ^= byte
        for _ in 0..<8 {
            crc = (crc & 0x80) != 0 ? ((crc &<< 1) ^ poly) : (crc &<< 1)
        }
    }
    return crc
}

/// Build the FF02 verify packet `08 fc <7 bytes>` answering a 6-byte challenge.
/// Body = [ms%1000 LE16][epoch_s LE32][CRC]. Validated live against the INT-11I-B.
func buildAuthResponse(challenge: [UInt8], now: Date = Date()) -> Data {
    let millis = Int64((now.timeIntervalSince1970 * 1000).rounded(.down))
    let epoch = UInt32(truncatingIfNeeded: millis / 1000)
    let rem = UInt16(truncatingIfNeeded: millis % 1000)
    let time6: [UInt8] = [
        UInt8(rem & 0xff), UInt8((rem >> 8) & 0xff),
        UInt8(epoch & 0xff), UInt8((epoch >> 8) & 0xff),
        UInt8((epoch >> 16) & 0xff), UInt8((epoch >> 24) & 0xff),
    ]
    let inner = crc8(time6, poly: 0xD5, initial: 0x00)      // CRC-8/DVB-S2
    let cdma = crc8(challenge, poly: 0x9B, initial: 0xFF)   // CRC-8/CDMA2000
    let chk = crc8(time6 + [inner, cdma], poly: 0xD5, initial: 0x00)
    let body = time6 + [chk]                                 // 7 bytes
    return Data([UInt8(body.count + 1), 0xFC] + body)        // 08 fc <7>
}

/// Split a FF02 notification into its concatenated <LEN><TYPE><body> frames.
func parseControlFrames(_ data: Data) -> [(type: UInt8, body: [UInt8])] {
    let b = [UInt8](data)
    var out: [(type: UInt8, body: [UInt8])] = []
    var i = 0
    while i < b.count {
        let ln = Int(b[i])
        if ln == 0 || i + 1 + ln > b.count { break }
        let frame = Array(b[(i + 1)..<(i + 1 + ln)])
        i += 1 + ln
        if let t = frame.first { out.append((t, Array(frame.dropFirst()))) }
    }
    return out
}

struct DiscoveredDevice: Identifiable, Equatable {
    let id: UUID
    let peripheral: CBPeripheral
    var name: String
    var rssi: Int
    var services: [CBUUID] = []   // advertised service UUIDs

    var looksLikeThermometer: Bool {
        // Strongest signal: advertises the FF00 service. Fall back to name hints.
        if services.contains(ProbeGATT.service) { return true }
        let lower = name.lowercased()
        return ProbeGATT.nameHints.contains { lower.contains($0) }
    }

    static func == (lhs: DiscoveredDevice, rhs: DiscoveredDevice) -> Bool { lhs.id == rhs.id }
}

enum ConnectionState: Equatable {
    case bluetoothOff
    case idle
    case scanning
    case connecting
    case connected
    case disconnected

    var label: String {
        switch self {
        case .bluetoothOff: return "Bluetooth Off"
        case .idle: return "Ready"
        case .scanning: return "Scanning…"
        case .connecting: return "Connecting…"
        case .connected: return "Connected"
        case .disconnected: return "Disconnected"
        }
    }
}

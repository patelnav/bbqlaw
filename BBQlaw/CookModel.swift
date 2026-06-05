import SwiftUI

// MARK: - Cook presets
//
// Recommended pull temps (°F). A meat with `doneness` exposes a level picker;
// "custom" has no preset target and hands off to the on-page slider.
struct Doneness: Equatable, Hashable {
    let label: String
    let f: Double
}

struct Meat: Identifiable, Equatable {
    let key: String
    let name: String
    let target: Double?          // nil = custom (set on slider)
    var doneness: [Doneness]? = nil
    var id: String { key }
}

let MEATS: [Meat] = [
    Meat(key: "brisket",  name: "Brisket",       target: 203),
    Meat(key: "pork",     name: "Pulled pork",   target: 203),
    Meat(key: "ribs",     name: "Ribs",          target: 198),
    Meat(key: "chicken",  name: "Chicken",       target: 165),
    Meat(key: "turkey",   name: "Turkey",        target: 165),
    Meat(key: "fish",     name: "Fish / salmon", target: 145),
    Meat(key: "porkchop", name: "Pork chop",     target: 145),
    Meat(key: "steak",    name: "Steak",         target: 130, doneness: [
        Doneness(label: "Rare", f: 120), Doneness(label: "Med rare", f: 130),
        Doneness(label: "Medium", f: 140), Doneness(label: "Med well", f: 150),
        Doneness(label: "Well", f: 160),
    ]),
    Meat(key: "burger",   name: "Burger",        target: 160),
    Meat(key: "custom",   name: "Custom",        target: nil),
]

func meat(forKey key: String?) -> Meat? {
    guard let key else { return nil }
    return MEATS.first { $0.key == key }
}

// MARK: - Probe (one connected thermometer)

enum ProbeMode: String, Equatable {
    case live       // streaming a real temperature
    case docked     // resting in the base / charging
    case noReading  // connected but no usable reading yet
}

/// Display + cook state for a single probe. The transient BLE handshake state
/// lives separately in `ProbeSession` (ThermometerManager); this is the part the
/// UI and the bridge consume.
struct Probe: Identifiable, Equatable {
    let id: UUID                 // == peripheral.identifier
    var name: String
    var colorHex: UInt32
    var meatKey: String?
    var doneness: String?
    var targetF: Double?
    var tempF: Double?
    var mode: ProbeMode = .noReading
    var probeBattery: Int?
    var baseBattery: Int?
    var connection: ConnectionState = .connecting
    var authState: AuthState = .none
    var readingNote: String?
    var advertisedName: String?
    var lastReadingAt: Date?     // when we last heard a reading from this probe

    // Alarm bookkeeping (so a mid-cook reconnect doesn't re-fire).
    var targetReached: Bool = false
    var hasFiredAlarm: Bool = false

    var color: Color { Color(hex: colorHex) }

    /// `#RRGGBB` for bridge / relay payloads.
    var colorHexString: String { String(format: "#%06X", colorHex) }

    /// Has the user set a target yet? (no-target vs with-target mode)
    var hasTarget: Bool { targetF != nil }

    /// True once a live reading meets/exceeds the target.
    var isReached: Bool {
        guard let t = targetF, mode == .live, let temp = tempF else { return false }
        return temp >= t
    }

    /// Human cook label for the "Cooking" row ("Steak · Medium", "Chicken", "Custom").
    var cookLabel: String {
        let base = meatKey == "custom" ? "Custom" : (meat(forKey: meatKey)?.name ?? "—")
        if let d = doneness { return "\(base) · \(d)" }
        return base
    }
}

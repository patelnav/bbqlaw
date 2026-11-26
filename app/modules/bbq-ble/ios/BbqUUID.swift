import CoreBluetooth

/// adapter-engine.md §4. `CBUUID(string:)` raises an uncatchable exception on bad
/// input, so every string from JS is checked first.
enum BbqUUID {
  private static let baseSuffix = "-0000-1000-8000-00805F9B34FB"

  static func make(_ value: String) -> CBUUID? {
    let isShort = value.utf8.count == 4 && value.allSatisfy(\.isHexDigit)
    guard isShort || UUID(uuidString: value) != nil else { return nil }
    return CBUUID(string: value)
  }

  /// Canonical form: uppercase; a Bluetooth-base UUID is its 4-digit form.
  static func string(_ uuid: CBUUID) -> String {
    let upper = uuid.uuidString.uppercased()
    if upper.count == 36, upper.hasPrefix("0000"), upper.hasSuffix(baseSuffix) {
      return String(upper.dropFirst(4).prefix(4))
    }
    return upper
  }
}

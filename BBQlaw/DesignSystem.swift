import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// MARK: - BBQlaw design tokens
//
// The single source of truth for the BBQlaw visual foundation, ported from the
// design system's `colors_and_type.css`. Big idea: an INSTRUMENT, not an app —
// the temperature is the hero, the screen warms as the cook climbs, surfaces are
// FLAT (hairline borders, no drop shadows). Clean cool-neutral light; warm
// smoke-charcoal dark. The only warm note is the ember brand accent + temp ramp.
//
// Production fonts are Apple's system faces (SF Pro Rounded ≈ Nunito for the hero,
// SF Pro Text ≈ Hanken for UI, SF Mono for readouts) — the design system uses the
// Google Fonts trio as the shippable web stand-in, but on-device we use SF.

enum BBQ {

    // MARK: Brand / ember
    static let ember       = adaptive(light: 0xE3611F, dark: 0xFF6B2C) // canonical brand orange (brighter on dark)
    static let emberFlat   = Color(hex: 0xE3611F)
    static let emberBright = Color(hex: 0xFF6B2C)
    static let emberDeep   = Color(hex: 0xC2410C) // pressed / deep fire
    static let emberInk    = Color(hex: 0x7C2D12)

    // MARK: Temperature ramp (cold → fire)
    static let tempCold = Color(hex: 0x4A7DB5) // cool slate-blue — far from target
    static let tempCool = Color(hex: 0x7FA8C9)
    static let tempWarm = Color(hex: 0xE0A93C) // amber / gold — climbing
    static let tempHot  = Color(hex: 0xE3611F) // ember — close
    static let tempFire = Color(hex: 0xC2410C) // deep fire — at / over target

    // MARK: Semantic status
    static let statusIdle = Color(hex: 0x4A7DB5) // connecting / authenticating / waiting / docked
    static let done       = adaptive(light: 0xE3611F, dark: 0xFF6B2C) // reached → ember, NOT green
    static let warning    = Color(hex: 0xE0A93C)
    static let danger     = Color(hex: 0xDC2626)

    // MARK: Neutrals (adaptive light / dark)
    static let bg        = adaptive(light: 0xF3F4F6, dark: 0x16110E) // page
    static let bgSunken  = adaptive(light: 0xE8EAEE, dark: 0x0E0B09) // wells, slider tracks
    static let surface   = adaptive(light: 0xFFFFFF, dark: 0x211A16) // cards, sheets
    static let surface2  = adaptive(light: 0xF5F6F8, dark: 0x2A211C)
    static let fg1       = adaptive(light: 0x191B20, dark: 0xF6EFE9) // primary text
    static let fg2       = adaptive(light: 0x5C616B, dark: 0xB39C8D) // secondary
    static let fg3       = adaptive(light: 0x8D929B, dark: 0x7D6B5E) // tertiary / muted
    static let line      = adaptive(light: 0xE2E4E9, dark: 0xFFFFFF, darkAlpha: 0.09)  // hairline borders
    static let lineStrong = adaptive(light: 0xC8CCD3, dark: 0xFFFFFF, darkAlpha: 0.16)

    // MARK: Tinted fills
    static let emberTint  = adaptive(light: 0xE3611F, lightAlpha: 0.10, dark: 0xFF6B2C, darkAlpha: 0.14)
    static let emberTint2 = adaptive(light: 0xE3611F, lightAlpha: 0.16, dark: 0xFF6B2C, darkAlpha: 0.22)
    static let slateTint  = adaptive(light: 0x4A7DB5, lightAlpha: 0.12, dark: 0x7FA8C9, darkAlpha: 0.16)
    static let dangerTint = Color(hex: 0xDC2626).opacity(0.12)

    // MARK: Radii (tighter / instrument, not pillowy)
    enum R {
        static let sm: CGFloat = 9    // chips, small controls
        static let md: CGFloat = 13   // buttons, inputs
        static let lg: CGFloat = 16   // cards
        static let xl: CGFloat = 22   // hero panels, sheets
    }

    // MARK: Per-probe identity colors (color-coded ports, like a real multi-probe rig)
    static let probeColors: [Color] = [
        Color(hex: 0xE3611F), Color(hex: 0x4A7DB5), Color(hex: 0xE0A93C), Color(hex: 0x7A9B57),
    ]
    static let probeColorsHex: [UInt32] = [0xE3611F, 0x4A7DB5, 0xE0A93C, 0x7A9B57]

    // MARK: Fonts
    /// Hero numerals + big display — SF Pro Rounded, heavy, tabular.
    static func display(_ size: CGFloat, weight: Font.Weight = .heavy) -> Font {
        .system(size: size, weight: weight, design: .rounded)
    }
    /// UI / body — SF Pro Text (system default).
    static func ui(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }
    /// Technical readouts, codes, IDs — SF Mono.
    static func mono(_ size: CGFloat, weight: Font.Weight = .medium) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

// MARK: - Hex / adaptive color helpers

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }
}

extension BBQ {
    /// A color that resolves differently in light vs dark mode.
    static func adaptive(light: UInt32, lightAlpha: Double = 1,
                         dark: UInt32, darkAlpha: Double = 1) -> Color {
        #if canImport(UIKit)
        return Color(UIColor { trait in
            let hex = trait.userInterfaceStyle == .dark ? dark : light
            let a = trait.userInterfaceStyle == .dark ? darkAlpha : lightAlpha
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: CGFloat(a)
            )
        })
        #else
        return Color(hex: light, alpha: lightAlpha)
        #endif
    }
}

// MARK: - Flat card surface (hairline border, no drop shadow)

struct BBQCard: ViewModifier {
    var padding: CGFloat = 18
    var radius: CGFloat = BBQ.R.lg
    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(BBQ.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(BBQ.line, lineWidth: 1)
            )
    }
}

extension View {
    /// Flat BBQlaw card: solid surface + hairline border, no shadow.
    func bbqCard(padding: CGFloat = 18, radius: CGFloat = BBQ.R.lg) -> some View {
        modifier(BBQCard(padding: padding, radius: radius))
    }

    /// Subtle ambient ember glow from the top — a whisper, intensifies when reached.
    func bbqGlow(reached: Bool = false) -> some View {
        background(
            RadialGradient(
                colors: [BBQ.emberFlat.opacity(reached ? 0.16 : 0.045), .clear],
                center: .init(x: 0.5, y: -0.12),
                startRadius: 0,
                endRadius: reached ? 520 : 420
            )
            .animation(.easeOut(duration: 0.42), value: reached)
            .ignoresSafeArea()
        )
    }
}

// MARK: - Temperature ramp helpers

enum TempRamp {
    /// Stepped tick color along the gauge (matches the design's tick-gauge logic).
    static func tickColor(at: Double, filled: Bool) -> Color {
        guard filled else { return BBQ.lineStrong }
        if at < 0.45 { return BBQ.tempCool }
        if at < 0.80 { return BBQ.tempWarm }
        return BBQ.ember
    }
}

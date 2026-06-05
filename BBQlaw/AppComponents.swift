import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// MARK: - Temperature formatting

enum BBQTemp {
    static func format(_ f: Double?, celsius: Bool) -> String {
        guard let f else { return "—" }
        let v = celsius ? fahrenheitToCelsius(f) : f
        return String(format: "%.0f", v.rounded())
    }

    static func unit(_ celsius: Bool) -> String { celsius ? "°C" : "°F" }

    static func toGo(tempF: Double, targetF: Double, celsius: Bool) -> Int {
        let diff = celsius
            ? (fahrenheitToCelsius(targetF) - fahrenheitToCelsius(tempF))
            : (targetF - tempF)
        return max(0, Int(diff.rounded()))
    }
}

/// Human-readable "time since" for the last-reading freshness line.
func bbqRelativeAge(_ date: Date) -> String {
    let s = max(0, Int(Date().timeIntervalSince(date)))
    if s < 2 { return "just now" }
    if s < 60 { return "\(s)s ago" }
    let m = s / 60
    if m < 60 { return "\(m)m ago" }
    let h = m / 60
    if h < 24 { return "\(h)h ago" }
    return "\(h / 24)d ago"
}

// MARK: - Primitives

struct BBQSegmentedControl: View {
    let options: [String]
    let selection: String
    let onSelect: (String) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.self) { option in
                Button { onSelect(option) } label: {
                    Text(option)
                        .font(BBQ.ui(14, weight: .bold))
                        .foregroundStyle(selection == option ? BBQ.fg1 : BBQ.fg2)
                        .padding(.horizontal, 13)
                        .padding(.vertical, 6)
                        .background(
                            selection == option ? BBQ.surface : Color.clear,
                            in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                        )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .background(BBQ.bgSunken, in: RoundedRectangle(cornerRadius: BBQ.R.sm, style: .continuous))
    }
}

struct BBQPrimaryButton: View {
    var title: String
    var icon: String? = nil
    var kind: Kind = .primary
    var fullWidth = false
    var disabled = false
    var action: () -> Void

    enum Kind { case primary, bordered, ghost, danger }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 9) {
                if let icon { Image(systemName: icon).font(.system(size: 19, weight: .semibold)) }
                Text(title).font(BBQ.ui(17, weight: .bold))
            }
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .padding(.horizontal, 22)
            .padding(.vertical, 15)
            .foregroundStyle(foreground)
            .background(background, in: RoundedRectangle(cornerRadius: BBQ.R.md, style: .continuous))
            .overlay {
                if kind == .bordered || kind == .danger {
                    RoundedRectangle(cornerRadius: BBQ.R.md, style: .continuous)
                        .strokeBorder(borderColor, lineWidth: kind == .danger ? 1.5 : 1.5)
                }
            }
        }
        .buttonStyle(BBQPressButtonStyle())
        .disabled(disabled)
        .opacity(disabled ? 0.4 : 1)
    }

    private var foreground: Color {
        switch kind {
        case .primary: return .white
        case .bordered: return BBQ.fg1
        case .ghost: return BBQ.ember
        case .danger: return BBQ.danger
        }
    }

    private var background: Color {
        switch kind {
        case .primary: return BBQ.ember
        case .bordered: return BBQ.surface
        case .ghost, .danger: return .clear
        }
    }

    private var borderColor: Color {
        kind == .danger ? BBQ.danger : BBQ.lineStrong
    }
}

private struct BBQPressButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct BBQTargetSlider: View {
    @Binding var value: Double
    var range: ClosedRange<Double> = 85...212

    var body: some View {
        GeometryReader { geo in
            let fraction = (value - range.lowerBound) / (range.upperBound - range.lowerBound)
            ZStack(alignment: .leading) {
                Capsule().fill(BBQ.bgSunken)
                Capsule()
                    .fill(
                        LinearGradient(
                            colors: [BBQ.tempCold, BBQ.tempWarm, BBQ.ember],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .frame(width: max(0, geo.size.width * fraction))
                Slider(value: $value, in: range, step: 1)
                    .tint(.clear)
            }
        }
        .frame(height: 28)
    }
}

struct BBQSheetHeader: View {
    // No custom grabber — the sheet's native drag indicator provides it.
    let title: String
    var body: some View {
        Text(title)
            .font(BBQ.display(22))
            .foregroundStyle(BBQ.fg1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 8)
            .padding(.bottom, 4)
    }
}

// MARK: - Live sparkline (recent temperature trace)

struct BBQSparkline: View {
    let samples: [Double]
    var color: Color = BBQ.ember
    var height: CGFloat = 46

    var body: some View {
        GeometryReader { geo in
            let pts = points(in: geo.size)
            ZStack {
                if pts.count >= 2 {
                    // Soft fill under the line.
                    Path { p in
                        p.move(to: CGPoint(x: pts[0].x, y: geo.size.height))
                        pts.forEach { p.addLine(to: $0) }
                        p.addLine(to: CGPoint(x: pts[pts.count - 1].x, y: geo.size.height))
                        p.closeSubpath()
                    }
                    .fill(LinearGradient(colors: [color.opacity(0.16), color.opacity(0.0)],
                                         startPoint: .top, endPoint: .bottom))
                    // The trace.
                    Path { p in
                        p.move(to: pts[0])
                        pts.dropFirst().forEach { p.addLine(to: $0) }
                    }
                    .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                    // Pulsing head — the "it's live" tell.
                    PulsingDot(color: color).position(pts[pts.count - 1])
                }
            }
        }
        .frame(height: height)
        .animation(.easeOut(duration: 0.35), value: samples)
        .accessibilityHidden(true)
    }

    private func points(in size: CGSize) -> [CGPoint] {
        guard samples.count >= 2 else { return [] }
        let lo = samples.min() ?? 0
        let hi = samples.max() ?? 1
        let range = max(1, hi - lo)
        let n = samples.count
        let topPad: CGFloat = 4, botPad: CGFloat = 4
        let h = size.height - topPad - botPad
        return samples.enumerated().map { i, v in
            let x = size.width * CGFloat(i) / CGFloat(n - 1)
            let y = topPad + h * (1 - CGFloat((v - lo) / range))
            return CGPoint(x: x, y: y)
        }
    }
}

private struct PulsingDot: View {
    var color: Color
    @State private var on = false
    var body: some View {
        ZStack {
            Circle().fill(color.opacity(0.25))
                .frame(width: 16, height: 16)
                .scaleEffect(on ? 1.0 : 0.4)
                .opacity(on ? 0 : 0.8)
            Circle().fill(color).frame(width: 6, height: 6)
        }
        .animation(.easeOut(duration: 1.2).repeatForever(autoreverses: false), value: on)
        .onAppear { on = true }
    }
}

// MARK: - Top bar

struct BBQTopBar: View {
    var onSettings: () -> Void
    var showChrome: Bool

    var body: some View {
        HStack {
            Logo(size: 21)
            Spacer()
            if showChrome {
                Button(action: onSettings) {
                    Image(systemName: "gearshape")
                        .font(.system(size: 20, weight: .regular))
                        .foregroundStyle(BBQ.fg2)
                        .frame(width: 38, height: 38)
                        .background(BBQ.surface, in: Circle())
                        .overlay(Circle().strokeBorder(BBQ.line, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Settings")
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 6)
        .padding(.bottom, 14)
    }
}

// MARK: - Status pill

struct BBQStatusPill: View {
    let label: String
    let tone: Tone
    var pulse: Bool = false

    enum Tone { case live, idle, danger }

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(foreground)
                .frame(width: 8, height: 8)
                .modifier(PulseModifier(active: pulse))
            Text(label)
                .font(BBQ.ui(13.5, weight: .semibold))
        }
        .foregroundStyle(foreground)
        .padding(.horizontal, 15)
        .padding(.vertical, 8)
        .background(background, in: Capsule())
    }

    private var foreground: Color {
        switch tone {
        case .live: return BBQ.ember
        case .idle: return BBQ.statusIdle
        case .danger: return BBQ.danger
        }
    }

    private var background: Color {
        switch tone {
        case .live: return BBQ.emberTint
        case .idle: return BBQ.slateTint
        case .danger: return BBQ.dangerTint
        }
    }
}

private struct PulseModifier: ViewModifier {
    let active: Bool
    @State private var pulsing = false

    func body(content: Content) -> some View {
        content
            .opacity(active ? (pulsing ? 0.35 : 1) : 1)
            .animation(active ? .easeInOut(duration: 1.6).repeatForever(autoreverses: true) : .default, value: pulsing)
            .onAppear { if active { pulsing = true } }
            .onChange(of: active) { _, on in pulsing = on }
    }
}

enum BBQStatusPillModel {
    static func make(thermo: ThermometerManager, active: Probe?) -> (label: String, tone: BBQStatusPill.Tone, pulse: Bool) {
        if thermo.bluetoothOff {
            return ("Bluetooth off", .danger, false)
        }
        guard let active else {
            return ("Ready", .idle, false)
        }
        switch active.connection {
        case .bluetoothOff:
            return ("Bluetooth off", .danger, false)
        case .connecting:
            return ("Connecting…", .idle, true)
        case .connected:
            switch active.authState {
            case .subscribing, .requested:
                return ("Authenticating…", .idle, true)
            case .waiting:
                return ("Waiting for probe…", .idle, true)
            case .failed:
                return ("Authentication failed", .danger, false)
            case .authed, .none:
                let count = thermo.connectedCount
                let label = count > 1 ? "\(count) probes · Connected" : "Connected"
                return (label, .live, false)
            }
        case .disconnected:
            return ("Disconnected", .idle, true)
        case .idle, .scanning:
            break
        }
        switch active.authState {
        case .subscribing, .requested:
            return ("Authenticating…", .idle, true)
        case .waiting:
            return ("Waiting for probe…", .idle, true)
        case .failed:
            return ("Authentication failed", .danger, false)
        default:
            return ("Ready", .idle, false)
        }
    }
}

// MARK: - Hero temperature

struct BBQHeroTemp: View {
    let probe: Probe
    var useCelsius: Bool
    var reached: Bool

    var body: some View {
        VStack(spacing: 4) {
            probeNameRow
            if probe.mode == .live {
                liveBody
            } else {
                idleBody
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }

    private var probeNameRow: some View {
        HStack(spacing: 7) {
            Circle().fill(probe.color).frame(width: 9, height: 9)
            Text(probe.name.uppercased())
                .font(BBQ.ui(13, weight: .bold))
                .tracking(0.06 * 13)
                .foregroundStyle(BBQ.fg2)
        }
        .padding(.bottom, 2)
    }

    @ViewBuilder
    private var liveBody: some View {
        if reached {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 30))
                .foregroundStyle(BBQ.ember)
                .padding(.bottom, 4)
        }
        HStack(alignment: .top, spacing: 2) {
            Text(displayTemp)
                .font(BBQ.display(96, weight: .heavy))
                .foregroundStyle(probe.hasTarget ? BBQ.ember : BBQ.fg1)
                .monospacedDigit()
                .minimumScaleFactor(0.5)
                .lineLimit(1)
            Text(BBQTemp.unit(useCelsius))
                .font(BBQ.display(30, weight: .bold))
                .foregroundStyle(BBQ.fg3)
                .padding(.top, 14)
        }
        if !probe.hasTarget {
            Text("No target set")
                .font(BBQ.ui(14, weight: .semibold))
                .foregroundStyle(BBQ.fg3)
                .padding(.top, 14)
        } else if reached {
            Text("Target reached")
                .font(BBQ.display(21, weight: .heavy))
                .foregroundStyle(BBQ.ember)
                .padding(.top, 6)
        } else if let temp = probe.tempF, let target = probe.targetF {
            tickGauge(temp: temp, target: target)
            Text("TARGET \(BBQTemp.format(target, celsius: useCelsius))\(BBQTemp.unit(useCelsius)) · \(BBQTemp.toGo(tempF: temp, targetF: target, celsius: useCelsius))° TO GO")
                .font(BBQ.mono(12.5, weight: .semibold))
                .foregroundStyle(BBQ.fg3)
                .padding(.top, 13)
        }
    }

    private var displayTemp: String {
        if reached, let target = probe.targetF {
            return BBQTemp.format(target, celsius: useCelsius)
        }
        return BBQTemp.format(probe.tempF, celsius: useCelsius)
    }

    private func tickGauge(temp: Double, target: Double) -> some View {
        let start = 80.0
        let prog = max(0, min(1, (temp - start) / (target - start)))
        return HStack(alignment: .bottom, spacing: 3) {
            ForEach(0..<30, id: \.self) { i in
                let at = Double(i) / 29.0
                let filled = at <= prog
                let major = i % 5 == 0
                Capsule()
                    .fill(TempRamp.tickColor(at: at, filled: filled))
                    .frame(width: 2, height: major ? 22 : 13)
                    .opacity(filled ? 1 : 0.55)
            }
        }
        .padding(.top, 22)
    }

    @ViewBuilder
    private var idleBody: some View {
        let docked = probe.mode == .docked
        ZStack {
            Circle()
                .fill(BBQ.slateTint)
                .frame(width: 96, height: 96)
            Image(systemName: docked ? "powerplug.fill" : "thermometer.medium")
                .font(.system(size: 46, weight: .regular))
                .foregroundStyle(BBQ.statusIdle)
        }
        .padding(.top, 10)
        Text(docked ? "Docked" : (probe.connection == .connected ? "No reading" : "No probe"))
            .font(BBQ.display(26, weight: .heavy))
            .foregroundStyle(BBQ.fg2)
        Text(docked ? "Probe in the base / charging" : (probe.connection == .connected ? "Take the probe out to read" : "Not connected"))
            .font(BBQ.ui(14, weight: .medium))
            .foregroundStyle(BBQ.fg3)
            .multilineTextAlignment(.center)
    }
}

// MARK: - Battery chips

struct BBQBatteryChips: View {
    let probePct: Int?
    let basePct: Int?
    var baseCharging: Bool = false

    var body: some View {
        HStack(spacing: 11) {
            chip(label: "Probe", pct: probePct, charging: false)
            chip(label: "Base", pct: basePct, charging: baseCharging)
        }
    }

    private func chip(label: String, pct: Int?, charging: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(BBQ.ui(11, weight: .bold))
                .tracking(0.08 * 11)
                .textCase(.uppercase)
                .foregroundStyle(BBQ.fg3)
            HStack(spacing: 8) {
                Image(systemName: charging ? "battery.100.bolt" : "battery.100")
                    .font(.system(size: 20))
                    .foregroundStyle(charging ? BBQ.ember : BBQ.fg2)
                Text(pct.map { "\($0)%" } ?? "—")
                    .font(BBQ.display(19, weight: .heavy))
                    .foregroundStyle(BBQ.fg1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 15)
        .padding(.vertical, 13)
        .background(BBQ.surface, in: RoundedRectangle(cornerRadius: BBQ.R.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: BBQ.R.md, style: .continuous)
                .strokeBorder(BBQ.line, lineWidth: 1)
        )
    }
}

// MARK: - Target card

struct BBQTargetCard: View {
    @EnvironmentObject private var thermo: ThermometerManager
    let probe: Probe
    var useCelsius: Bool
    var reached: Bool
    var canRemove: Bool
    var onOpenMeat: () -> Void
    var onRemove: () -> Void

    @State private var nameDraft: String = ""

    var body: some View {
        VStack(spacing: 0) {
            nameRow
            BBQHairline()
            if probe.hasTarget {
                cookingRow
                BBQHairline()
                targetSliderRow
                BBQHairline()
                alertRow
            } else {
                noTargetBlock
            }
            if canRemove {
                BBQHairline()
                removeRow
            }
        }
        .background(BBQ.surface, in: RoundedRectangle(cornerRadius: BBQ.R.lg, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: BBQ.R.lg, style: .continuous)
                .strokeBorder(BBQ.line, lineWidth: 1)
        )
        .onAppear { nameDraft = probe.name }
        .onChange(of: probe.id) { _, _ in nameDraft = probe.name }
        .onChange(of: probe.name) { _, n in if nameDraft != n { nameDraft = n } }
    }

    private var nameRow: some View {
        HStack(spacing: 10) {
            Circle().fill(probe.color).frame(width: 10, height: 10)
            TextField("Name this probe", text: $nameDraft)
                .font(BBQ.display(18, weight: .heavy))
                .foregroundStyle(BBQ.fg1)
                .onSubmit { commitName() }
                .onChange(of: nameDraft) { _, v in
                    if v.count > 24 { nameDraft = String(v.prefix(24)) }
                }
            Image(systemName: "pencil")
                .font(.system(size: 15))
                .foregroundStyle(BBQ.fg3)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
        .onDisappear { commitName() }
    }

    private func commitName() {
        let trimmed = nameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != probe.name else {
            nameDraft = probe.name
            return
        }
        thermo.setName(probe.id, trimmed)
    }

    private var cookingRow: some View {
        Button(action: onOpenMeat) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("COOKING")
                        .font(BBQ.ui(11, weight: .bold))
                        .tracking(0.08 * 11)
                        .foregroundStyle(BBQ.fg3)
                    Text(probe.cookLabel)
                        .font(BBQ.ui(16, weight: .bold))
                        .foregroundStyle(BBQ.fg1)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(BBQ.fg3)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 13)
        }
        .buttonStyle(.plain)
    }

    private var targetSliderRow: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack {
                Text("Target")
                    .font(BBQ.ui(15, weight: .semibold))
                    .foregroundStyle(BBQ.fg2)
                Spacer()
                if let target = probe.targetF {
                    Text("\(BBQTemp.format(target, celsius: useCelsius))\(BBQTemp.unit(useCelsius))")
                        .font(BBQ.display(17, weight: .heavy))
                        .foregroundStyle(BBQ.fg1)
                }
            }
            if let binding = targetBinding {
                BBQTargetSlider(value: binding)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 16)
    }

    private var targetBinding: Binding<Double>? {
        guard probe.hasTarget else { return nil }
        let id = probe.id
        return Binding(
            get: { thermo.probes.first(where: { $0.id == id })?.targetF ?? 165 },
            set: { thermo.setTarget(id, $0) }
        )
    }

    private var alertRow: some View {
        HStack(spacing: 9) {
            Image(systemName: reached ? "checkmark.seal.fill" : "bell")
                .font(.system(size: 18))
                .foregroundStyle(reached ? BBQ.ember : BBQ.fg3)
            if reached {
                Text("Target reached — you've been alerted")
            } else if let target = probe.targetF {
                Text("Alerts you at \(BBQTemp.format(target, celsius: useCelsius))\(BBQTemp.unit(useCelsius))")
            }
            Spacer(minLength: 0)
        }
        .font(BBQ.ui(14, weight: .medium))
        .foregroundStyle(reached ? BBQ.ember : BBQ.fg2)
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
    }

    private var noTargetBlock: some View {
        VStack(spacing: 9) {
            BBQPrimaryButton(title: "Set a target", icon: "bell", kind: .bordered, fullWidth: true, action: onOpenMeat)
            Text("Watching the temperature. Set a target to get alerted.")
                .font(BBQ.ui(13))
                .foregroundStyle(BBQ.fg3)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }

    private var removeRow: some View {
        Button(action: onRemove) {
            HStack(spacing: 6) {
                Image(systemName: "xmark")
                    .font(.system(size: 14, weight: .bold))
                Text("Remove this probe")
                    .font(BBQ.ui(14, weight: .bold))
            }
            .foregroundStyle(BBQ.danger)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
    }
}

private struct BBQHairline: View {
    var body: some View {
        Rectangle().fill(BBQ.line).frame(height: 1)
    }
}

// MARK: - Probe rail

struct BBQProbeRail: View {
    let probes: [Probe]
    let activeId: UUID
    var useCelsius: Bool
    var onSelect: (UUID) -> Void
    var onAdd: () -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(probes) { probe in
                    probeChip(probe)
                }
                addChip
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 4)
        }
    }

    private func probeChip(_ probe: Probe) -> some View {
        let active = probe.id == activeId
        let done = probe.isReached
        return Button { onSelect(probe.id) } label: {
            HStack(spacing: 8) {
                Circle().fill(probe.color).frame(width: 9, height: 9)
                Text(probe.name)
                    .font(BBQ.ui(14, weight: .bold))
                    .foregroundStyle(BBQ.fg1)
                Text(chipTemp(probe))
                    .font(BBQ.display(14, weight: .heavy))
                    .foregroundStyle(done ? BBQ.ember : (active ? probe.color : BBQ.fg2))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(active ? BBQ.surface : Color.clear, in: Capsule())
            .overlay(
                Capsule().strokeBorder(active ? probe.color : BBQ.lineStrong, lineWidth: 1.5)
            )
        }
        .buttonStyle(.plain)
    }

    private var addChip: some View {
        Button(action: onAdd) {
            HStack(spacing: 5) {
                Image(systemName: "plus")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(BBQ.fg3)
                Text("Add")
                    .font(BBQ.ui(14, weight: .bold))
                    .foregroundStyle(BBQ.fg2)
            }
            .padding(.horizontal, 15)
            .padding(.vertical, 9)
            .overlay(Capsule().strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [5, 4])).foregroundStyle(BBQ.lineStrong))
        }
        .buttonStyle(.plain)
    }

    private func chipTemp(_ probe: Probe) -> String {
        if probe.mode == .docked { return "—" }
        return "\(BBQTemp.format(probe.tempF, celsius: useCelsius))°"
    }
}

// MARK: - Add device (onboarding)

struct BBQAddDeviceScreen: View {
    let pairing: Bool
    let pairingLabel: String
    var btOff: Bool
    var onScan: () -> Void

    var body: some View {
        if pairing {
            VStack(spacing: 18) {
                ProgressView()
                    .controlSize(.large)
                    .tint(BBQ.ember)
                Text(pairingLabel)
                    .font(BBQ.display(22, weight: .heavy))
                    .foregroundStyle(BBQ.fg1)
                Text("Keep the probe out of the base and nearby while we connect.")
                    .font(BBQ.ui(14))
                    .foregroundStyle(BBQ.fg3)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 240)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack {
                Spacer(minLength: 20)
                VStack(spacing: 16) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .fill(BBQ.emberTint)
                            .frame(width: 92, height: 92)
                        Image(systemName: "thermometer.medium")
                            .font(.system(size: 46))
                            .foregroundStyle(BBQ.ember)
                    }
                    Text("Add your thermometer")
                        .font(BBQ.display(28, weight: .heavy))
                        .foregroundStyle(BBQ.fg1)
                    Text("Take the probe out of the base so it's measuring, then scan. No vendor app, no account.")
                        .font(BBQ.ui(15))
                        .foregroundStyle(BBQ.fg2)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 290)
                }
                Spacer()
                VStack(spacing: 10) {
                    BBQPrimaryButton(title: "Scan for device", icon: "magnifyingglass", fullWidth: true, disabled: btOff, action: onScan)
                    if btOff {
                        Text("Turn on Bluetooth to scan.")
                            .font(BBQ.ui(13, weight: .medium))
                            .foregroundStyle(BBQ.danger)
                    }
                }
                .padding(.bottom, 8)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, 4)
        }
    }
}

// MARK: - Sheets

struct BBQScannerSheet: View {
    @EnvironmentObject private var thermo: ThermometerManager
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    BBQSheetHeader(title: "Thermometers")
                    VStack(spacing: 9) {
                        ForEach(thermo.discovered) { device in
                            Button {
                                thermo.connect(device)
                                dismiss()
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(device.name)
                                            .font(BBQ.ui(16, weight: .bold))
                                            .foregroundStyle(BBQ.fg1)
                                        if device.looksLikeThermometer {
                                            Text("thermometer")
                                                .font(BBQ.ui(12, weight: .semibold))
                                                .foregroundStyle(BBQ.ember)
                                        }
                                    }
                                    Spacer()
                                    Text("\(device.rssi) dBm")
                                        .font(BBQ.mono(13))
                                        .foregroundStyle(BBQ.fg3)
                                }
                                .padding(.horizontal, 16)
                                .padding(.vertical, 14)
                                .background(BBQ.surface2, in: RoundedRectangle(cornerRadius: BBQ.R.md, style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: BBQ.R.md, style: .continuous)
                                        .strokeBorder(BBQ.line, lineWidth: 1)
                                )
                            }
                            .buttonStyle(.plain)
                        }
                        HStack(spacing: 9) {
                            ProgressView().controlSize(.small)
                            Text("Searching…")
                                .font(BBQ.ui(13, weight: .medium))
                                .foregroundStyle(BBQ.fg3)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
            .background(BBQ.bg)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        thermo.stopScan()
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .onAppear { if !thermo.scanning { thermo.startScan() } }
    }
}

struct BBQMeatSheet: View {
    @EnvironmentObject private var thermo: ThermometerManager
    @Environment(\.dismiss) private var dismiss
    let probeId: UUID
    var useCelsius: Bool

    @State private var expandedKey: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    BBQSheetHeader(title: "What are you cooking?")
                    BBQMeatOptions(
                        probe: thermo.probes.first { $0.id == probeId },
                        useCelsius: useCelsius,
                        expandedKey: $expandedKey,
                        onApply: { meatKey, doneness, target in
                            thermo.setCook(probeId, meatKey: meatKey, doneness: doneness, target: target)
                            dismiss()
                        }
                    )
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
            .background(BBQ.bg)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .onAppear {
            if let p = thermo.probes.first(where: { $0.id == probeId }) {
                expandedKey = p.meatKey
            }
        }
    }
}

struct BBQMeatOptions: View {
    let probe: Probe?
    var useCelsius: Bool
    @Binding var expandedKey: String?
    var onApply: (String?, String?, Double?) -> Void

    var body: some View {
        VStack(spacing: 8) {
            ForEach(MEATS) { meat in
                meatRow(meat)
            }
        }
    }

    private func meatRow(_ meat: Meat) -> some View {
        let selected = meat.key == expandedKey
        let expandable = meat.doneness != nil
        return VStack(spacing: 8) {
            Button {
                if expandable {
                    expandedKey = selected ? nil : meat.key
                } else if meat.key == "custom" {
                    let fallback = probe?.targetF ?? 165
                    onApply("custom", nil, fallback)
                } else {
                    onApply(meat.key, nil, meat.target)
                }
            } label: {
                HStack {
                    Text(meat.name)
                        .font(BBQ.ui(16, weight: .bold))
                        .foregroundStyle(BBQ.fg1)
                    Spacer()
                    HStack(spacing: 8) {
                        Text(rightLabel(meat, selected: selected))
                            .font(BBQ.ui(14, weight: .semibold))
                            .foregroundStyle(selected ? BBQ.ember : BBQ.fg3)
                        if expandable {
                            Image(systemName: "chevron.right")
                                .rotationEffect(.degrees(selected ? 90 : 0))
                                .foregroundStyle(selected ? BBQ.ember : BBQ.fg3)
                        } else if selected {
                            Image(systemName: "checkmark.seal.fill")
                                .foregroundStyle(BBQ.ember)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .background(selected ? BBQ.emberTint : BBQ.surface2, in: RoundedRectangle(cornerRadius: BBQ.R.md, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: BBQ.R.md, style: .continuous)
                        .strokeBorder(selected ? BBQ.ember : BBQ.line, lineWidth: 1)
                )
            }
            .buttonStyle(.plain)

            if selected, let levels = meat.doneness {
                FlowDonenessButtons(
                    levels: levels,
                    probeDoneness: probe?.doneness,
                    useCelsius: useCelsius,
                    meatKey: meat.key,
                    meatName: meat.name,
                    onApply: onApply
                )
            }
        }
    }

    private func rightLabel(_ meat: Meat, selected: Bool) -> String {
        if meat.doneness != nil { return "5 levels" }
        if meat.key == "custom" { return "Set on slider" }
        if let t = meat.target {
            return "\(BBQTemp.format(t, celsius: useCelsius))\(BBQTemp.unit(useCelsius))"
        }
        return ""
    }
}

private struct FlowDonenessButtons: View {
    let levels: [Doneness]
    let probeDoneness: String?
    var useCelsius: Bool
    let meatKey: String
    let meatName: String
    var onApply: (String?, String?, Double?) -> Void

    var body: some View {
        FlowLayout(spacing: 8) {
            ForEach(levels, id: \.label) { level in
                let picked = probeDoneness == level.label
                Button {
                    onApply(meatKey, level.label, level.f)
                } label: {
                    Text("\(level.label) · \(BBQTemp.format(level.f, celsius: useCelsius))°")
                        .font(BBQ.ui(14, weight: .semibold))
                        .foregroundStyle(picked ? .white : BBQ.fg1)
                        .padding(.horizontal, 13)
                        .padding(.vertical, 9)
                        .background(picked ? BBQ.ember : BBQ.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .strokeBorder(BBQ.lineStrong, lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 4)
        .padding(.bottom, 4)
    }
}

/// Simple wrapping layout for doneness chips.
private struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = arrange(proposal: proposal, subviews: subviews)
        return result.size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrange(proposal: proposal, subviews: subviews)
        for (index, frame) in result.frames.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), proposal: .unspecified)
        }
    }

    private func arrange(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, frames: [CGRect]) {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var frames: [CGRect] = []
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > maxWidth, x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            frames.append(CGRect(x: x, y: y, width: size.width, height: size.height))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
        }
        return (CGSize(width: maxWidth, height: y + rowHeight), frames)
    }
}

struct BBQSettingsSheet: View {
    @EnvironmentObject private var thermo: ThermometerManager
    @EnvironmentObject private var bridgeLink: BridgeLinkManager
    @Environment(\.dismiss) private var dismiss

    @State private var linking = false
    @State private var copiedMessage: String?

    let activeId: UUID?
    var useCelsius: Bool
    var onToggleUnits: (Bool) -> Void
    var onSelectProbe: (UUID) -> Void
    var onAddDevice: () -> Void
    var onRemoveProbe: (UUID) -> Void
    var onArmBaseBuzzerChange: (Bool) -> Void
    var onBaseVolumeChange: (Int) -> Void

    @AppStorage("armBaseBuzzer") private var armBaseBuzzer = false
    @AppStorage("baseBuzzerLevel") private var baseBuzzerLevel = 2

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    BBQSheetHeader(title: "Settings")

                    sectionLabel("Units")
                    settingsGroup {
                        HStack {
                            Text("Temperature")
                                .font(BBQ.ui(16, weight: .semibold))
                                .foregroundStyle(BBQ.fg1)
                            Spacer()
                            BBQSegmentedControl(
                                options: ["°F", "°C"],
                                selection: useCelsius ? "°C" : "°F",
                                onSelect: { onToggleUnits($0 == "°C") }
                            )
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                    }

                    sectionLabel("Devices")
                        .padding(.top, 22)
                    settingsGroup {
                        ForEach(Array(thermo.probes.enumerated()), id: \.element.id) { index, probe in
                            if index > 0 { BBQHairline().padding(.leading, 16) }
                            probeDeviceRow(probe)
                        }
                        if !thermo.probes.isEmpty { BBQHairline().padding(.leading, 16) }
                        Button(action: onAddDevice) {
                            HStack(spacing: 11) {
                                Image(systemName: "plus")
                                    .font(.system(size: 18, weight: .bold))
                                    .foregroundStyle(BBQ.ember)
                                Text("Add device")
                                    .font(BBQ.ui(16, weight: .semibold))
                                    .foregroundStyle(BBQ.ember)
                                Spacer()
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 15)
                        }
                        .buttonStyle(.plain)
                    }

                    if hasAuthedProbe {
                        sectionLabel("Base station")
                            .padding(.top, 22)
                        settingsGroup {
                            Toggle(isOn: $armBaseBuzzer) {
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack(spacing: 7) {
                                        Text("Beep the base at target")
                                            .font(BBQ.ui(16, weight: .semibold))
                                            .foregroundStyle(BBQ.fg1)
                                        Text("Experimental")
                                            .font(BBQ.ui(10, weight: .bold))
                                            .tracking(0.04 * 10)
                                            .textCase(.uppercase)
                                            .foregroundStyle(BBQ.warning)
                                            .padding(.horizontal, 6)
                                            .padding(.vertical, 2)
                                            .background(BBQ.warning.opacity(0.14), in: Capsule())
                                    }
                                    Text("Arms your thermometer's own buzzer at the target — verify it alarms at the right temperature.")
                                        .font(BBQ.ui(13))
                                        .foregroundStyle(BBQ.fg3)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            .tint(BBQ.ember)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                            .onChange(of: armBaseBuzzer) { _, on in
                                onArmBaseBuzzerChange(on)
                            }

                            BBQHairline().padding(.leading, 16)

                            HStack {
                                Text("Base volume")
                                    .font(BBQ.ui(16, weight: .semibold))
                                    .foregroundStyle(BBQ.fg1)
                                Spacer(minLength: 8)
                                BBQSegmentedControl(
                                    options: ["Mute", "Low", "Med", "High"],
                                    selection: baseVolumeLabel,
                                    onSelect: { selectBaseVolume($0) }
                                )
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                        }
                    }

                    sectionLabel("Automations")
                        .padding(.top, 22)
                    settingsGroup {
                        if bridgeLink.isLinked, let url = bridgeLink.shareURL {
                            HStack(spacing: 0) {
                                Button {
                                    copyLink(url, message: "Copied ✓")
                                } label: {
                                    HStack(spacing: 8) {
                                        Text(url)
                                            .font(BBQ.mono(14))
                                            .foregroundStyle(BBQ.fg1)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                        Spacer(minLength: 8)
                                        Image(systemName: "doc.on.doc")
                                            .font(.system(size: 14, weight: .semibold))
                                            .foregroundStyle(BBQ.fg3)
                                    }
                                    .padding(.vertical, 15)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)

                                Button {
                                    bridgeLink.unlink()
                                } label: {
                                    Image(systemName: "trash")
                                        .font(.system(size: 16))
                                        .foregroundStyle(BBQ.danger)
                                        .padding(.leading, 14)
                                        .padding(.vertical, 15)
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Unlink OpenClaw")
                            }
                            .padding(.horizontal, 16)
                        } else if linking {
                            HStack(spacing: 9) {
                                ProgressView().controlSize(.small)
                                Text("Linking…")
                                    .font(BBQ.ui(15, weight: .semibold))
                                    .foregroundStyle(BBQ.fg3)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 15)
                        } else {
                            BBQPrimaryButton(title: "Link to OpenClaw & copy", icon: "link", fullWidth: true) {
                                Task { await linkAndCopy() }
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                        }
                    }

                    if let copiedMessage {
                        Text(copiedMessage)
                            .font(BBQ.ui(13, weight: .semibold))
                            .foregroundStyle(BBQ.ember)
                            .padding(.horizontal, 6)
                            .padding(.top, 8)
                    }

                    if let err = bridgeLink.lastError {
                        Text(err)
                            .font(BBQ.ui(13))
                            .foregroundStyle(BBQ.danger)
                            .padding(.horizontal, 6)
                            .padding(.top, copiedMessage == nil ? 8 : 4)
                    }

                    Text("Forward live readings so your agent can watch the cook and message someone when it's done. Your phone stays the Bluetooth bridge.")
                        .font(BBQ.ui(13))
                        .foregroundStyle(BBQ.fg3)
                        .padding(.horizontal, 6)
                        .padding(.top, 10)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
            .background(BBQ.bg)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    private var hasAuthedProbe: Bool {
        thermo.probes.contains { $0.connection == .connected && $0.authState == .authed }
    }

    private var baseVolumeLabel: String {
        switch baseBuzzerLevel {
        case 0: return "Mute"
        case 1: return "Low"
        case 3: return "High"
        default: return "Med"
        }
    }

    private func selectBaseVolume(_ label: String) {
        let level: Int
        switch label {
        case "Mute": level = 0
        case "Low": level = 1
        case "High": level = 3
        default: level = 2
        }
        baseBuzzerLevel = level
        onBaseVolumeChange(level)
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(BBQ.ui(11, weight: .bold))
            .tracking(0.08 * 11)
            .textCase(.uppercase)
            .foregroundStyle(BBQ.fg3)
            .padding(.horizontal, 4)
            .padding(.bottom, 8)
    }

    private func settingsGroup<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0) { content() }
            .background(BBQ.surface, in: RoundedRectangle(cornerRadius: BBQ.R.md, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: BBQ.R.md, style: .continuous)
                    .strokeBorder(BBQ.line, lineWidth: 1)
            )
    }

    private func probeDeviceRow(_ probe: Probe) -> some View {
        HStack(spacing: 0) {
            Button {
                onSelectProbe(probe.id)
            } label: {
                HStack {
                    HStack(spacing: 11) {
                        Circle().fill(probe.color).frame(width: 10, height: 10)
                        Text(probe.name)
                            .font(BBQ.ui(16, weight: .semibold))
                            .foregroundStyle(BBQ.fg1)
                    }
                    Spacer()
                    Text(probe.mode == .docked ? "Docked" : "\(BBQTemp.format(probe.tempF, celsius: useCelsius))\(BBQTemp.unit(useCelsius))")
                        .font(BBQ.ui(15, weight: .semibold))
                        .foregroundStyle(BBQ.fg3)
                    if probe.id == activeId {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.system(size: 17))
                            .foregroundStyle(BBQ.ember)
                    }
                }
                .padding(.vertical, 15)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button {
                onRemoveProbe(probe.id)
            } label: {
                Image(systemName: "trash")
                    .font(.system(size: 16))
                    .foregroundStyle(BBQ.danger)
                    .padding(.leading, 14)
                    .padding(.vertical, 15)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(probe.name)")
        }
        .padding(.horizontal, 16)
    }

    private func copyLink(_ url: String, message: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = url
        #endif
        flashCopied(message)
    }

    private func linkAndCopy() async {
        linking = true
        await bridgeLink.pair()
        linking = false
        if let url = bridgeLink.shareURL {
            copyLink(url, message: "Link copied to clipboard ✓")
        }
    }

    private func flashCopied(_ message: String) {
        copiedMessage = message
        Task {
            try? await Task.sleep(for: .seconds(2))
            if copiedMessage == message { copiedMessage = nil }
        }
    }
}

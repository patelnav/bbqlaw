import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

struct ContentView: View {
    @EnvironmentObject private var thermo: ThermometerManager
    @EnvironmentObject private var bridgeLink: BridgeLinkManager
    @EnvironmentObject private var bridgeClient: BridgeClient
    @AppStorage("useCelsius") private var useCelsius = false
    @State private var showScanner = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 28) {
                    statusPill
                    temperatureReadout
                    bridgeLinkCard
                    if thermo.connection == .connected {
                        batteryRow
                        targetCard
                        debugLine
                    } else {
                        connectCard
                    }
                }
                .padding()
            }
            .navigationTitle("BBQlaw")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(useCelsius ? "°C" : "°F") { useCelsius.toggle() }
                        .font(.headline)
                }
            }
            .sheet(isPresented: $showScanner) { ScannerSheet() }
        }
    }

    // MARK: Pieces
    private var statusText: String {
        var s = thermo.connectedName.map { "\($0) · \(thermo.connection.label)" } ?? thermo.connection.label
        if thermo.connection == .connected, !thermo.authState.label.isEmpty {
            s += " · \(thermo.authState.label)"
        }
        return s
    }

    private var statusPill: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(thermo.connection == .connected ? Color.green : Color.secondary)
                .frame(width: 10, height: 10)
            Text(statusText)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(.thinMaterial, in: Capsule())
    }

    private var temperatureReadout: some View {
        VStack(spacing: 4) {
            if let f = thermo.temperatureF {
                let shown = useCelsius ? fahrenheitToCelsius(f) : f
                Text(String(format: "%.0f", shown))
                    .font(.system(size: 96, weight: .bold, design: .rounded))
                    .foregroundStyle(thermo.targetReached ? .green : .primary)
                    .contentTransition(.numericText())
                Text(useCelsius ? "°C" : "°F")
                    .font(.title2).foregroundStyle(.secondary)
            } else {
                Text("—")
                    .font(.system(size: 96, weight: .bold, design: .rounded))
                    .foregroundStyle(.secondary)
                Text(thermo.connection == .connected ? (thermo.readingNote ?? "no probe reading") : "not connected")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 24))
    }

    private var batteryRow: some View {
        HStack(spacing: 16) {
            batteryPill("Probe", thermo.probeBattery)
            batteryPill("Base", thermo.baseBattery)
        }
    }

    private func batteryPill(_ label: String, _ pct: Int?) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "battery.100")
            Text(label)
            Text(pct.map { "\($0)%" } ?? "—").bold()
        }
        .font(.subheadline)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }

    private var targetCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Toggle(isOn: $thermo.alarmEnabled) {
                Text("Alert at target").font(.headline)
            }
            HStack {
                Text("Target")
                Spacer()
                let shownTarget = useCelsius ? fahrenheitToCelsius(thermo.targetF) : thermo.targetF
                Text(String(format: "%.0f%@", shownTarget, useCelsius ? "°C" : "°F")).bold()
            }
            Slider(value: $thermo.targetF, in: 85...212, step: 1)
            if thermo.targetReached {
                Label("Target reached", systemImage: "checkmark.seal.fill")
                    .foregroundStyle(.green).font(.subheadline)
            }
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18))
    }

    private var debugLine: some View {
        Group {
            if let raw = thermo.lastRawTemp {
                Text("raw FF01: \(raw.map { String(format: "%02x", $0) }.joined(separator: " "))")
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private var bridgeLinkCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Link to your OpenClaw 🔥").font(.headline)
                Spacer()
                Text(bridgeLink.isLinked ? "Linked" : "Not linked")
                    .font(.subheadline)
                    .foregroundStyle(bridgeLink.isLinked ? .green : .secondary)
            }
            if let deviceId = bridgeLink.deviceId, bridgeLink.isLinked {
                Text("Device: \(deviceId)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let latestUrl = bridgeLink.latestUrl, bridgeLink.isLinked {
                Text("Poll: \(latestUrl)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .textSelection(.enabled)
            }
            if let readerToken = bridgeLink.readerToken, bridgeLink.isLinked {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Reader token (for OpenClaw)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Text(readerToken)
                        .font(.system(.caption2, design: .monospaced))
                        .textSelection(.enabled)
                        .lineLimit(3)
                    Button("Copy reader token") {
                        #if canImport(UIKit)
                        UIPasteboard.general.string = readerToken
                        #endif
                    }
                    .font(.footnote)
                    .buttonStyle(.bordered)
                }
                Text("Give this reader token to your OpenClaw so it can poll the cook.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else if bridgeLink.isLinked {
                Text("Reader token was shown at link time — tap Unlink and Link again to mint a new one.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let err = bridgeLink.lastError {
                Text(err).font(.footnote).foregroundStyle(.red)
            } else if let ok = bridgeLink.lastSuccess {
                Text(ok).font(.footnote).foregroundStyle(.green)
            }
            if let pushErr = bridgeClient.lastPushError, bridgeLink.isLinked {
                Text(pushErr).font(.footnote).foregroundStyle(.orange)
            }
            HStack(spacing: 12) {
                if bridgeLink.isLinked {
                    Button("Unlink", role: .destructive) { bridgeLink.unlink() }
                        .buttonStyle(.bordered)
                        .frame(maxWidth: .infinity)
                } else {
                    Button {
                        Task { await bridgeLink.pair() }
                    } label: {
                        Label("Link", systemImage: "link")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18))
    }

    private var connectCard: some View {
        VStack(spacing: 12) {
            Image(systemName: "thermometer.medium")
                .font(.system(size: 40)).foregroundStyle(.orange)
            Text("Connect your thermometer")
                .font(.headline)
            Text("Take the probe out of the base so it's measuring, then scan. No vendor app needed.")
                .font(.footnote).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button {
                thermo.startScan()
                showScanner = true
            } label: {
                Label("Scan for device", systemImage: "dot.radiowaves.left.and.right")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(thermo.connection == .bluetoothOff)
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18))
    }
}

struct ScannerSheet: View {
    @EnvironmentObject private var thermo: ThermometerManager
    @Environment(\.dismiss) private var dismiss
    @State private var showAll = false

    private var thermometers: [DiscoveredDevice] { thermo.discovered.filter(\.looksLikeThermometer) }
    private var shown: [DiscoveredDevice] { showAll ? thermo.discovered : thermometers }
    private var otherCount: Int { thermo.discovered.count - thermometers.count }

    var body: some View {
        NavigationStack {
            List {
                // Multiple thermometers all appear here — tap the one you want.
                ForEach(shown) { device in
                    Button {
                        thermo.connect(device)
                        dismiss()
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(device.name).foregroundStyle(.primary)
                                if device.looksLikeThermometer {
                                    Text("thermometer").font(.caption).foregroundStyle(.orange)
                                }
                            }
                            Spacer()
                            Text("\(device.rssi) dBm").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                // Escape hatch in case a thermometer doesn't match the filter.
                if !showAll, otherCount > 0 {
                    Button("Show all devices (\(otherCount) other)") { showAll = true }
                        .font(.subheadline)
                } else if showAll {
                    Button("Show thermometers only") { showAll = false }
                        .font(.subheadline)
                }
            }
            .overlay {
                if shown.isEmpty {
                    ContentUnavailableView {
                        Label("Searching for thermometers…", systemImage: "antenna.radiowaves.left.and.right")
                    } description: {
                        Text("Make sure the probe is out of the base and powered on.")
                    } actions: {
                        if otherCount > 0 { Button("Show all devices") { showAll = true } }
                    }
                }
            }
            .navigationTitle(showAll ? "Nearby Devices" : "Thermometers")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { thermo.stopScan(); dismiss() }
                }
            }
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(ThermometerManager())
        .environmentObject(BridgeLinkManager())
        .environmentObject(BridgeClient(thermo: ThermometerManager()))
}

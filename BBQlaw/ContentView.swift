import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var thermo: ThermometerManager
    @EnvironmentObject private var bridgeLink: BridgeLinkManager
    @AppStorage("useCelsius") private var useCelsius = false

    @State private var activeId: UUID?
    @State private var showScanner = false
    @State private var showMeat = false
    @State private var showSettings = false
    @State private var showLink = false

    private var active: Probe? {
        if let id = activeId, let p = thermo.probes.first(where: { $0.id == id }) { return p }
        return thermo.probes.first
    }

    private var showMonitoring: Bool { thermo.anyConnected }

    private var isPairing: Bool {
        !thermo.probes.isEmpty && !thermo.anyConnected
    }

    private var pairingLabel: String {
        guard let active else { return "Connecting…" }
        let status = BBQStatusPillModel.make(thermo: thermo, active: active)
        return status.label
    }

    var body: some View {
        ZStack {
            BBQ.bg.ignoresSafeArea()
            if showMonitoring, let active {
                VStack(spacing: 0) {
                    BBQTopBar(onSettings: { showSettings = true }, showChrome: true)
                    let status = BBQStatusPillModel.make(thermo: thermo, active: active)
                    BBQStatusPill(label: status.label, tone: status.tone, pulse: status.pulse)
                    freshnessLine(active).padding(.top, 3)
                    ScrollView {
                        VStack(spacing: 13) {
                            monitoringContent(active: active)
                        }
                        .padding(.horizontal, 18)
                        .padding(.top, 10)
                        .padding(.bottom, 22)
                    }
                }
            } else {
                // Onboarding / pairing fills the screen so it centers properly
                // (a ScrollView would collapse the centering Spacers).
                BBQAddDeviceScreen(
                    pairing: isPairing,
                    pairingLabel: pairingLabel,
                    btOff: thermo.bluetoothOff,
                    onScan: openScanner
                )
                .padding(.horizontal, 22)
            }
        }
        .bbqGlow(reached: active?.isReached ?? false)
        .sheet(isPresented: $showScanner) { BBQScannerSheet() }
        .sheet(isPresented: $showMeat) {
            if let id = active?.id {
                BBQMeatSheet(probeId: id, useCelsius: useCelsius)
            }
        }
        .sheet(isPresented: $showSettings) {
            BBQSettingsSheet(
                activeId: active?.id,
                useCelsius: useCelsius,
                onToggleUnits: { useCelsius = $0 },
                onSelectProbe: { id in
                    activeId = id
                    showSettings = false
                },
                onAddDevice: {
                    showSettings = false
                    openScanner()
                },
                onRemoveProbe: { id in
                    thermo.removeProbe(id)
                    if activeId == id { activeId = thermo.probes.first?.id }
                    if thermo.probes.isEmpty { showSettings = false }
                },
                onOpenLink: {
                    showSettings = false
                    showLink = true
                }
            )
        }
        .sheet(isPresented: $showLink) { BBQLinkSheet() }
        .onChange(of: thermo.probes.count) { oldCount, newCount in
            syncActiveProbe(oldCount: oldCount, newCount: newCount)
        }
        .onChange(of: thermo.probes.map(\.id)) { _, _ in
            if let id = activeId, !thermo.probes.contains(where: { $0.id == id }) {
                activeId = thermo.probes.first?.id
            }
        }
    }

    @ViewBuilder
    private func monitoringContent(active: Probe) -> some View {
        BBQHeroTemp(probe: active, useCelsius: useCelsius, reached: active.isReached)

        if thermo.probes.count > 1 {
            BBQProbeRail(
                probes: thermo.probes,
                activeId: active.id,
                useCelsius: useCelsius,
                onSelect: { activeId = $0 },
                onAdd: openScanner
            )
        }

        BBQBatteryChips(
            probePct: active.probeBattery,
            basePct: active.baseBattery,
            baseCharging: active.mode == .docked
        )

        BBQTargetCard(
            probe: active,
            useCelsius: useCelsius,
            reached: active.isReached,
            canRemove: thermo.probes.count > 1,
            onOpenMeat: { showMeat = true },
            onRemove: {
                let removing = active.id
                thermo.removeProbe(removing)
                if activeId == removing {
                    activeId = thermo.probes.first?.id
                }
            }
        )
    }

    @ViewBuilder
    private func freshnessLine(_ probe: Probe) -> some View {
        if let last = probe.lastReadingAt {
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                Text("Updated \(bbqRelativeAge(last))")
                    .font(BBQ.ui(11.5, weight: .medium))
                    .foregroundStyle(BBQ.fg3)
            }
        }
    }

    private func openScanner() {
        thermo.startScan()
        showScanner = true
    }

    private func syncActiveProbe(oldCount: Int, newCount: Int) {
        if newCount > oldCount, let added = thermo.probes.last {
            activeId = added.id
        } else if activeId == nil {
            activeId = thermo.probes.first?.id
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(ThermometerManager())
        .environmentObject(BridgeLinkManager())
        .environmentObject(BridgeClient(thermo: ThermometerManager()))
}

import SwiftUI
import UserNotifications

@main
struct BBQlawApp: App {
    @StateObject private var thermo = ThermometerManager()
    @StateObject private var bridgeLink: BridgeLinkManager
    @StateObject private var bridgeClient: BridgeClient

    init() {
        let thermo = ThermometerManager()
        _thermo = StateObject(wrappedValue: thermo)
        _bridgeLink = StateObject(wrappedValue: BridgeLinkManager())
        _bridgeClient = StateObject(wrappedValue: BridgeClient(thermo: thermo))
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(thermo)
                .environmentObject(bridgeLink)
                .environmentObject(bridgeClient)
                .onAppear {
                    UNUserNotificationCenter.current()
                        .requestAuthorization(options: [.alert, .sound]) { _, _ in }
                    bridgeLink.refreshLinkState()
                    bridgeClient.refresh()
                }
        }
    }
}

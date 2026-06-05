import SwiftUI
import UserNotifications

/// Presents target-reached notifications (with sound) even while the app is in
/// the foreground — otherwise iOS silently suppresses them.
final class BBQNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = BBQNotificationDelegate()
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }
}

@main
struct BBQlawApp: App {
    @StateObject private var thermo: ThermometerManager
    @StateObject private var bridgeLink: BridgeLinkManager
    @StateObject private var bridgeClient: BridgeClient

    init() {
        let thermo = ThermometerManager()
        _thermo = StateObject(wrappedValue: thermo)
        _bridgeLink = StateObject(wrappedValue: BridgeLinkManager())
        _bridgeClient = StateObject(wrappedValue: BridgeClient(thermo: thermo))
        UNUserNotificationCenter.current().delegate = BBQNotificationDelegate.shared
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

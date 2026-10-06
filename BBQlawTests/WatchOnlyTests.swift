import XCTest
@testable import BBQlaw

final class WatchOnlyTests: XCTestCase {
    private var suite: String!
    private var defaults: UserDefaults!
    private var manager: ThermometerManager!
    private var id: UUID!

    override func setUp() {
        super.setUp()
        suite = "bbqlaw.watch-tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
        manager = ThermometerManager(defaults: defaults)
        id = UUID()
        manager.probes = [Probe(id: id, name: "Test probe", colorHex: 0xE3611F,
                                meatKey: "chicken", targetF: 165, tempF: 120,
                                mode: .live, connection: .connected)]
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        manager = nil
        defaults = nil
        super.tearDown()
    }

    func testWatchOnlySuppressesReachedStateAndRetainsTemperatureAndTarget() {
        manager.setAlarmEnabled(id, false)
        manager.setCook(id, meatKey: "chicken", doneness: nil, target: 100)
        let probe = manager.probes[0]
        XCTAssertFalse(probe.alarmEnabled)
        XCTAssertNil(probe.alarmTargetF)
        XCTAssertFalse(probe.hasTarget)
        XCTAssertFalse(probe.isReached)
        XCTAssertFalse(probe.targetReached)
        XCTAssertFalse(probe.hasFiredAlarm)
        XCTAssertEqual(probe.tempF, 120)
        XCTAssertEqual(probe.targetF, 100)
        XCTAssertEqual(probe.mode, .live)
        XCTAssertTrue(probe.shouldMuteBaseBuzzer)
        manager.setTarget(id, 110)
        XCTAssertFalse(manager.probes[0].targetReached)
        XCTAssertFalse(manager.probes[0].hasFiredAlarm)
    }

    func testRestoringAlarmModeUsesSavedTargetAndBuzzerPreference() {
        manager.setAlarmEnabled(id, false)
        manager.setAlarmEnabled(id, true)
        let probe = manager.probes[0]
        XCTAssertTrue(probe.alarmEnabled)
        XCTAssertEqual(probe.alarmTargetF, 165)
        XCTAssertFalse(probe.shouldMuteBaseBuzzer)
        manager.setCook(id, meatKey: "custom", doneness: nil, target: 100)
        XCTAssertTrue(manager.probes[0].isReached)
        XCTAssertTrue(manager.probes[0].hasFiredAlarm)
        manager.setAlarmEnabled(id, false)
        XCTAssertFalse(manager.probes[0].hasFiredAlarm)
        manager.setBaseMuted(id, true)
        manager.setAlarmEnabled(id, true)
        XCTAssertTrue(manager.probes[0].shouldMuteBaseBuzzer)
    }

    func testWatchModeAndTargetPersistAcrossManagerReloads() {
        manager.setBaseMuted(id, true)
        manager.setAlarmEnabled(id, false)
        let restored = ThermometerManager(defaults: defaults).makeProbe(id: id, advertisedName: nil)
        XCTAssertFalse(restored.alarmEnabled)
        XCTAssertEqual(restored.targetF, 165)
        XCTAssertEqual(restored.meatKey, "chicken")
        XCTAssertTrue(restored.baseMuted)
        XCTAssertTrue(restored.shouldMuteBaseBuzzer)
        manager.setAlarmEnabled(id, true)
        let enabled = ThermometerManager(defaults: defaults).makeProbe(id: id, advertisedName: nil)
        XCTAssertTrue(enabled.alarmEnabled)
        XCTAssertEqual(enabled.alarmTargetF, 165)
    }

    func testExistingSavedCooksKeepAlarmModeByDefault() throws {
        manager.setTarget(id, 165)
        let data = try XCTUnwrap(defaults.data(forKey: "bbqlaw.cooks.v2"))
        var saved = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: [String: Any]])
        saved[id.uuidString]?.removeValue(forKey: "alarmEnabled")
        defaults.set(try JSONSerialization.data(withJSONObject: saved), forKey: "bbqlaw.cooks.v2")
        let restored = ThermometerManager(defaults: defaults).makeProbe(id: id, advertisedName: nil)
        XCTAssertTrue(restored.alarmEnabled)
        XCTAssertEqual(restored.alarmTargetF, 165)
        XCTAssertFalse(restored.shouldMuteBaseBuzzer)
    }
}

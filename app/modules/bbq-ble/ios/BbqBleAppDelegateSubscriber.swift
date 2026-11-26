import ExpoModulesCore
import UIKit

/// Creates the central at launch so iOS can hand over restored state even when
/// no scene connects (React Native may not start).
public class BbqBleAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    BbqCentral.shared.start()
    return true
  }
}

internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    NotificationCenter.default.addObserver(
      self, selector: #selector(adoptSavedScene(_:)), name: UIScene.willConnectNotification, object: nil)

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // A scene saved by the SwiftUI 1.0 app.
  @objc private func adoptSavedScene(_ notification: Notification) {
    guard let scene = notification.object as? UIWindowScene,
      let delegateClass = scene.session.configuration.delegateClass,
      !delegateClass.isSubclass(of: ExpoAppSceneDelegate.self),
      let factory = reactNativeFactory else {
      return
    }
    let sceneDelegate = ExpoAppSceneDelegate()
    scene.delegate = sceneDelegate
    let sceneWindow = UIWindow(windowScene: scene)
    sceneDelegate.window = sceneWindow
    window = sceneWindow
    factory.startReactNative(withModuleName: "main", in: sceneWindow, launchOptions: nil)
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }

  // Universal Links
  public override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}

// The iOS 27 SDK stops an app at launch unless it uses the UIScene life cycle.
// Expo ships `EXExpoAppSceneDelegate`, but the SDK 57 template does not adopt it.
//
// Upgrades from the SwiftUI 1.0 app need one more step. iOS keeps the scene session
// that 1.0 saved, with `SwiftUI.AppSceneDelegate`, and ignores the Info.plist for it.
// The result is a black screen. When such a scene connects, the app delegate gives it
// Expo's scene delegate and starts React Native in its window.
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const CLASS_LINE = 'class AppDelegate: ExpoAppDelegate {';
const CLASS_LINE_SCENE = 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {';
const WINDOW_START = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

`;
const OBSERVE = `    NotificationCenter.default.addObserver(
      self, selector: #selector(adoptSavedScene(_:)), name: UIScene.willConnectNotification, object: nil)

`;
const LINKING_MARK = '  // Linking API\n';
const ADOPT = `  // A scene saved by the SwiftUI 1.0 app.
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

`;

function replaceOnce(source, from, to) {
  if (!source.includes(from)) {
    throw new Error(`withSceneLifecycle: AppDelegate.swift no longer contains:\n${from}`);
  }
  return source.replace(from, () => to);
}

module.exports = (config) => {
  config = withAppDelegate(config, (mod) => {
    let source = mod.modResults.contents;
    if (!source.includes(CLASS_LINE_SCENE)) {
      source = replaceOnce(source, CLASS_LINE, CLASS_LINE_SCENE);
      source = replaceOnce(source, WINDOW_START, OBSERVE);
      mod.modResults.contents = replaceOnce(source, LINKING_MARK, ADOPT + LINKING_MARK);
    }
    return mod;
  });
  return withInfoPlist(config, (mod) => {
    mod.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          { UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: 'EXExpoAppSceneDelegate' },
        ],
      },
    };
    return mod;
  });
};

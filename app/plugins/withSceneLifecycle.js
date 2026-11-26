// The iOS 27 SDK stops an app at launch unless it uses the UIScene life cycle.
// Expo ships `EXExpoAppSceneDelegate`, but the SDK 57 template does not adopt it.
// This is the same setup as Expo's documented scene life cycle: the scene delegate
// creates the window and starts React Native.
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

function replaceOnce(source, from, to) {
  if (!source.includes(from)) {
    throw new Error(`withSceneLifecycle: AppDelegate.swift no longer contains:\n${from}`);
  }
  return source.replace(from, to);
}

module.exports = (config) => {
  config = withAppDelegate(config, (mod) => {
    if (!mod.modResults.contents.includes(CLASS_LINE_SCENE)) {
      mod.modResults.contents = replaceOnce(
        replaceOnce(mod.modResults.contents, CLASS_LINE, CLASS_LINE_SCENE),
        WINDOW_START,
        '',
      );
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

/** Shared by native builds and the self-hosted publisher. */
module.exports = {
  // Store counters and the display version do not change native compatibility.
  // Every other native source stays, including config plugins and modules.
  sourceSkips: ['PackageJsonAndroidAndIosScriptsIfNotContainRun', 'ExpoConfigVersions'],
  // Local files that Xcode and CocoaPods create and git does not track. A fresh
  // clone and a built checkout must give the same runtime. Expo's own defaults
  // name some of these folders, but not the files inside `project.xcworkspace`.
  ignorePaths: [
    '**/ios/**/project.xcworkspace/**/*',
    '**/ios/**/xcuserdata/**/*',
    '**/ios/*.xcworkspace/xcshareddata/swiftpm/**/*',
    '**/ios/build/**/*',
    '**/ios/Pods/**/*',
  ],
  // Expo does not hash the code signing certificate by default. A new trust root
  // must select a new runtime.
  extraSources: [{ type: 'file', filePath: 'updates/certificate.pem', reasons: ['otaSigningCertificate'] }],
};

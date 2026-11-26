/** Shared by native builds and the self-hosted publisher. */
module.exports = {
  // Store counters and the display version do not change native compatibility.
  // Every other native source stays, including config plugins and modules.
  sourceSkips: ['PackageJsonAndroidAndIosScriptsIfNotContainRun', 'ExpoConfigVersions'],
  // Expo does not hash the code signing certificate by default. A new trust root
  // must select a new runtime.
  extraSources: [{ type: 'file', filePath: 'updates/certificate.pem', reasons: ['otaSigningCertificate'] }],
};

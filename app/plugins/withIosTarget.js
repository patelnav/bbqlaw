// 1. iOS 17.0 deployment target (spec R2).
// 2. BBQlaw uses local notifications only, so drop the push entitlement that the
//    expo-notifications plugin adds.
const { withEntitlementsPlist, withPodfileProperties, withXcodeProject } = require('expo/config-plugins');

const TARGET = '17.0';

module.exports = (config) => {
  config = withPodfileProperties(config, (mod) => {
    mod.modResults['ios.deploymentTarget'] = TARGET;
    return mod;
  });
  config = withXcodeProject(config, (mod) => {
    const configurations = mod.modResults.pbxXCBuildConfigurationSection();
    for (const entry of Object.values(configurations)) {
      if (entry && entry.buildSettings && entry.buildSettings.IPHONEOS_DEPLOYMENT_TARGET) {
        entry.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = TARGET;
      }
    }
    return mod;
  });
  return withEntitlementsPlist(config, (mod) => {
    delete mod.modResults['aps-environment'];
    return mod;
  });
};

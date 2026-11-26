import fs from 'node:fs';
import path from 'node:path';
import type { ExpoConfig } from 'expo/config';

// OTA channel baked into the binary (spec §8). No in-app switch.
const CHANNEL = process.env.BBQLAW_CHANNEL?.trim() || 'production';
if (CHANNEL !== 'production' && CHANNEL !== 'preview') {
  throw new Error(`BBQLAW_CHANNEL must be "production" or "preview", got "${CHANNEL}".`);
}

// `app/scripts/ota-keygen.ts` creates the certificate. Until it exists, updates stay
// disabled so the app still builds. Run `expo prebuild` again after it is created.
const CERTIFICATE = './updates/certificate.pem';
const hasCertificate = fs.existsSync(path.resolve(__dirname, CERTIFICATE));

const config: ExpoConfig = {
  name: 'BBQlaw',
  slug: 'bbqlaw',
  scheme: 'bbqlaw',
  version: '2.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  platforms: ['ios'],
  runtimeVersion: { policy: 'fingerprint' },
  updates: hasCertificate
    ? {
        enabled: true,
        url: 'https://updates.bbqlaw.app/manifest',
        checkAutomatically: 'ON_LOAD',
        fallbackToCacheTimeout: 0,
        codeSigningCertificate: CERTIFICATE,
        codeSigningMetadata: { keyid: 'root', alg: 'rsa-v1_5-sha256' },
        requestHeaders: { 'expo-channel-name': CHANNEL },
      }
    : { enabled: false },
  ios: {
    bundleIdentifier: 'app.bbqlaw.ios',
    appleTeamId: '866MN8FJSP',
    buildNumber: '4',
    supportsTablet: false,
    infoPlist: {
      CFBundleDisplayName: 'BBQlaw',
      UIBackgroundModes: ['bluetooth-central'],
      NSBluetoothAlwaysUsageDescription:
        'BBQlaw connects to your wireless meat thermometer over Bluetooth to show live cooking temperatures.',
      ITSAppUsesNonExemptEncryption: false,
    },
    privacyManifests: {
      NSPrivacyTracking: false,
      NSPrivacyTrackingDomains: [],
      NSPrivacyAccessedAPITypes: [
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
          NSPrivacyAccessedAPITypeReasons: ['C617.1'],
        },
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime',
          NSPrivacyAccessedAPITypeReasons: ['35F9.1'],
        },
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
          NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
        },
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace',
          NSPrivacyAccessedAPITypeReasons: ['E174.1'],
        },
      ],
      NSPrivacyCollectedDataTypes: [
        {
          NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeOtherDiagnosticData',
          NSPrivacyCollectedDataTypeLinked: false,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        },
      ],
    },
  },
  plugins: [
    ['expo-splash-screen', { backgroundColor: '#F3F4F6', dark: { backgroundColor: '#16110E' } }],
    'expo-secure-store',
    'expo-sharing',
    './plugins/withIosTarget',
    './plugins/withSceneLifecycle',
  ],
};

export default config;

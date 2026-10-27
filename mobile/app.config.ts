import type { ExpoConfig } from 'expo/config';
import project from './project.config.json';
const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID || project.projectId;
const config: ExpoConfig = {
  name: 'hob', slug: 'hob-mobile', scheme: 'hob', version: '1.0.0', orientation: 'default', userInterfaceStyle: 'automatic',
  platforms: ['ios', 'android'], icon: './assets/hob-mark.png',
  ...(project.owner ? { owner: project.owner } : {}),
  ios: { supportsTablet: true, bundleIdentifier: process.env.HOB_IOS_BUNDLE_ID || project.iosBundleIdentifier, infoPlist: { ITSAppUsesNonExemptEncryption: false } },
  android: { package: process.env.HOB_ANDROID_PACKAGE || project.androidPackage, ...(process.env.GOOGLE_SERVICES_JSON ? { googleServicesFile: process.env.GOOGLE_SERVICES_JSON } : {}) },
  plugins: ['expo-secure-store', 'expo-notifications', ['expo-image-picker', { photosPermission: 'Choose media to attach to your hob prompt.', cameraPermission: 'Take a photo to attach to your hob prompt.', microphonePermission: false }]],
  extra: { ...(projectId ? { eas: { projectId } } : {}) },
};
export default config;

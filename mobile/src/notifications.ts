import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { AppState, Platform } from 'react-native';
import { deviceRequest } from './api';
import type { Connection } from './connection';

Notifications.setNotificationHandler({ handleNotification: async notification => {
  const show = AppState.currentState !== 'active' || notification.request.content.data?.kind === 'test';
  return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
} });
export async function enableNotifications(connection: Connection) {
  if (!Device.isDevice) throw new Error('Use a physical phone to test push notifications.');
  const projectId = Constants.easConfig?.projectId || Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) throw new Error('This build needs an EAS project ID and Android/iOS push credentials. See mobile/README.md.');
  if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('hob-messages', { name: 'hob messages', importance: Notifications.AndroidImportance.HIGH });
  const current = await Notifications.getPermissionsAsync();
  const permission = current.granted ? current : await Notifications.requestPermissionsAsync();
  if (!permission.granted) throw new Error('Notifications are disabled. You can enable them in your phone settings.');
  const result = await Notifications.getExpoPushTokenAsync({ projectId });
  await deviceRequest(connection, 'device/push', 'PUT', { pushToken: result.data });
}
export { Notifications };

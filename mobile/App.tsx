import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, Image, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import * as Device from 'expo-device';
import { StatusBar } from 'expo-status-bar';
import { instanceRequest, discover, deviceRequest, login, LoginExpired } from './src/api';
import { normalizeInstance, notificationTarget } from './src/connection';
import type { Connection, Instance } from './src/connection';
import { enableNotifications, Notifications } from './src/notifications';
import { NativeWorkspace } from './src/NativeWorkspace';
import type { ConversationTarget } from './src/NativeWorkspace';
import { WorkspaceHeader } from './src/WorkspaceHeader';
import { AppText as Text, Button, Field, messageOf, NativeTheme, Notice, Page, usePalette } from './src/ui';

const STORAGE = 'hob.connection.v1';
interface AccountProps { connection: Connection; onDisconnect: () => Promise<void> }
const AccountContext = React.createContext<AccountProps | null>(null);
function ConnectionScreen({ navigation }: { navigation?: { goBack: () => void } }) {
  const account = React.useContext(AccountContext)!;
  const [busy, setBusy] = useState(false), [push, setPush] = useState(false), [message, setMessage] = useState(''), operation = useRef(false);
  useEffect(() => { let active = true; void deviceRequest<{ pushEnabled: boolean }>(account.connection, 'device').then(result => { if (active) setPush(result.pushEnabled); }).catch(error => { if (active) setMessage(messageOf(error)); }); return () => { active = false; }; }, [account.connection]);
  const [prefs, setPrefs] = useState<{ muted: string[]; start: string; end: string; zone: string } | null>(null);
  const [bots, setBots] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    void Promise.all([deviceRequest<NonNullable<typeof prefs>>(account.connection, 'device/preferences'), instanceRequest<{agents: typeof bots}>(account.connection.origin, '/api/agents', { token: account.connection.token })])
      .then(([value, roster]) => { setPrefs(value); setBots(roster.agents); }).catch(err => setMessage(messageOf(err)));
  }, [account.connection]);
  async function act(work: () => Promise<void>) {
    if (operation.current) return; operation.current = true; setBusy(true); setMessage('');
    try { await work(); } catch (error) { setMessage(messageOf(error)); }
    finally { operation.current = false; setBusy(false); }
  }
  return <Page title="Your connection" header={navigation ? <WorkspaceHeader canGoBack onGoBack={() => navigation.goBack()} title="Your connection" /> : undefined}>
    <Notice>{account.connection.origin}</Notice><Notice>{push ? 'Agent notifications are enabled.' : 'Agent notifications are off for this device.'}</Notice>
    <Button label={push ? 'Disable notifications' : 'Enable notifications'} disabled={busy} onPress={() => void act(async () => {
      if (push) await deviceRequest(account.connection, 'device/push', 'PUT', { pushToken: null }); else await enableNotifications(account.connection);
      setPush(!push); setMessage(push ? 'Notifications disabled.' : 'This device is registered for agent notifications.');
    })} />
    {push && <Button label="Send a test notification" secondary disabled={busy} onPress={() => void act(async () => { await deviceRequest(account.connection, 'device/test', 'POST'); setMessage('Test notification queued.'); })} />}
    {push && prefs && <>
      <Field label="Quiet hours start (HH:MM)" value={prefs.start} onChangeText={start => setPrefs({ ...prefs, start })} placeholder="22:00" />
      <Field label="Quiet hours end (HH:MM)" value={prefs.end} onChangeText={end => setPrefs({ ...prefs, end })} placeholder="07:00" />
      {bots.map(bot => <Button key={bot.id} secondary label={bot.name + (prefs.muted.includes(bot.id) ? ' · Muted' : ' · Notifications on')} onPress={() => setPrefs({ ...prefs, muted: prefs.muted.includes(bot.id) ? prefs.muted.filter(id => id !== bot.id) : [...prefs.muted, bot.id] })} />)}
      <Button label="Save notification preferences" disabled={busy} onPress={() => void act(async () => { await deviceRequest(account.connection, 'device/preferences', 'PUT', { ...prefs, zone: Intl.DateTimeFormat().resolvedOptions().timeZone }); setMessage('Notification preferences saved.'); })} />
    </>}
    {Boolean(message) && <Notice>{message}</Notice>}
    <Button label="Disconnect this device" secondary danger disabled={busy} onPress={() => Alert.alert('Disconnect this device?', 'This signs out and stops its server-side notifications.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Disconnect', style: 'destructive', onPress: () => void act(account.onDisconnect) }])} />
  </Page>;
}
function HobApp() {
  const p = usePalette();
  const [url, setUrl] = useState(''), [password, setPassword] = useState(''), [busy, setBusy] = useState(true), [error, setError] = useState('');
  const [verified, setVerified] = useState<{ origin: string; info: Instance } | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null), connectionRef = useRef<Connection | null>(null), operation = useRef(false);
  const [target, setTarget] = useState<ConversationTarget | null>(null), lastNotification = useRef('');
  const setCurrent = useCallback((next: Connection | null) => { connectionRef.current = next; setConnection(next); }, []);
  const expire = useCallback(async (message: string) => {
    await SecureStore.deleteItemAsync(STORAGE); setCurrent(null); setVerified(null); setPassword(''); setTarget(null); setError(message);
  }, [setCurrent]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const saved = await SecureStore.getItemAsync(STORAGE); if (!saved || !alive) return;
        const current = JSON.parse(saved) as Connection, origin = normalizeInstance(current.origin, __DEV__); setUrl(origin);
        if (!/^hobm_[a-f0-9]{64}$/.test(current.token) || current.expiresAt <= Date.now()) { await SecureStore.deleteItemAsync(STORAGE); return; }
        if (alive) setCurrent(current);
        const instance = await discover(origin);
        if (instance.instanceId !== current.instanceId) throw new LoginExpired('The instance identity changed. Sign in again.');
        await deviceRequest(current, 'device');
      } catch (error) { if (error instanceof LoginExpired || error instanceof SyntaxError) await expire(messageOf(error)); else if (alive) setError(messageOf(error)); }
      finally { if (alive) setBusy(false); }
    })(); return () => { alive = false; };
  }, [expire, setCurrent]);
  const handleNotification = useCallback((response: Notifications.NotificationResponse | null) => {
    const current = connectionRef.current; if (!response || !current) return;
    const target = notificationTarget(response.notification.request.content.data || {}, current);
    const id = response.notification.request.identifier;
    if (!target || id === lastNotification.current) return;
    lastNotification.current = id; setTarget({ ...target, requestId: id });
  }, []);
  useEffect(() => {
    const listener = Notifications.addNotificationResponseReceivedListener(handleNotification);
    const appState = AppState.addEventListener('change', state => {
      const current = connectionRef.current; if (state !== 'active' || !current) return;
      void deviceRequest(current, 'device').catch(error => { if (error instanceof LoginExpired && connectionRef.current?.token === current.token) void expire(messageOf(error)); });
    }); return () => { listener.remove(); appState.remove(); };
  }, [handleNotification, expire]);
  useEffect(() => { if (connection) void Notifications.getLastNotificationResponseAsync().then(handleNotification).catch(() => undefined); }, [connection, handleNotification]);
  useEffect(() => {
    if (connection) return;
    const back = BackHandler.addEventListener('hardwareBackPress', () => { if (!verified || busy) return false; setVerified(null); setPassword(''); setError(''); return true; });
    return () => back.remove();
  }, [connection, verified, busy]);
  async function verify() {
    if (operation.current) return; operation.current = true; setBusy(true); setError('');
    try { const origin = normalizeInstance(url, __DEV__), info = await discover(origin); setVerified({ origin, info }); setUrl(origin); }
    catch (error) { setError(messageOf(error)); } finally { operation.current = false; setBusy(false); }
  }
  async function signIn() {
    if (!verified || !password || operation.current) return; operation.current = true; setBusy(true); setError('');
    try {
      const current = await login(verified.origin, password, Device.deviceName || (Platform.OS === 'ios' ? 'iPhone' : 'Android'));
      await SecureStore.setItemAsync(STORAGE, JSON.stringify(current), { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
      setPassword(''); setTarget(null); setCurrent(current);
    } catch (error) { setError(messageOf(error)); } finally { operation.current = false; setBusy(false); }
  }
  const disconnect = useCallback(async () => {
    const current = connectionRef.current; if (!current) return;
    try { await deviceRequest(current, 'device', 'DELETE'); }
    catch (error) { if (!(error instanceof LoginExpired)) throw new Error('Could not revoke this device. Reconnect and try again.'); }
    await SecureStore.deleteItemAsync(STORAGE); setCurrent(null); setVerified(null); setTarget(null); setError(''); lastNotification.current = '';
  }, [setCurrent]);
  if (connection) return <AccountContext.Provider value={{ connection, onDisconnect: disconnect }}><NativeWorkspace key={connection.token} connection={connection} target={target} connectionScreen={ConnectionScreen} /></AccountContext.Provider>;
  return <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }} edges={['top', 'bottom', 'left', 'right']}><StatusBar style={p.bg === '#060605' ? 'light' : 'dark'} />
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 28, width: '100%', maxWidth: 520, alignSelf: 'center' }} keyboardShouldPersistTaps="handled">
      <Image source={require('./assets/hob-mark.png')} style={{ width: 72, height: 72, marginBottom: 30 }} accessibilityLabel="hob" />
      <Text style={{ color: p.ink, fontSize: 35, letterSpacing: -1, fontWeight: '600', marginBottom: 16 }}>{verified ? 'Welcome back.' : 'Your hob. Anywhere.'}</Text>
      <Notice>{verified ? 'Your instance is ready. Sign in with its password.' : 'Connect to your own instance to bring your bots, files, and workspace with you.'}</Notice>
      {verified ? <><Notice>{verified.origin}</Notice><Field label="Instance password" secureTextEntry value={password} onChangeText={setPassword} editable={!busy} textContentType="password" autoComplete="current-password" returnKeyType="go" onSubmitEditing={() => void signIn()} />
        <Button label={busy ? 'Signing in…' : 'Sign in'} disabled={busy || !password} onPress={() => void signIn()} /><Button label="Use a different instance" secondary disabled={busy} onPress={() => { setVerified(null); setPassword(''); setError(''); }} /></>
        : <><Field label="hob instance URL" placeholder="https://hob.example.com" value={url} onChangeText={setUrl} editable={!busy} autoCapitalize="none" autoCorrect={false} keyboardType="url" textContentType="URL" returnKeyType="go" onSubmitEditing={() => void verify()} />
          <Button label={busy ? 'Checking instance…' : 'Connect to instance'} disabled={busy || !url.trim()} onPress={() => void verify()} /></>}
      {Boolean(error) && <Notice error>{error}</Notice>}{busy && <ActivityIndicator color={p.accent} style={{ marginTop: 16 }} />}
    </ScrollView></KeyboardAvoidingView>
  </SafeAreaView>;
}
export default function App() { return <SafeAreaProvider><NativeTheme><HobApp /></NativeTheme></SafeAreaProvider>; }

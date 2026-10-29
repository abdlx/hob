import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, Image, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useColorScheme } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import * as SecureStore from 'expo-secure-store';
import * as Device from 'expo-device';
import { StatusBar } from 'expo-status-bar';
import { discover, deviceRequest, login, LoginExpired } from './src/api';
import { normalizeInstance, notificationTarget, sameInstance } from './src/connection';
import type { Connection, Instance } from './src/connection';
import { pickMedia } from './src/media';
import { enableNotifications, Notifications } from './src/notifications';
import { downloadFile } from './src/download';

const STORAGE = 'hob.connection.v1';
const errorMessage = (error: unknown) => error instanceof Error ? error.message.slice(0, 400) : 'Unable to connect. Try again.';
const injected = `(() => {
  document.documentElement.dataset.hobNative = '1';
  window.addEventListener('hob:unauthorized', () => window.ReactNativeWebView?.postMessage(JSON.stringify({type:'auth-expired'})));
  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[download]') : null;
    if (!link || !window.ReactNativeWebView) return;
    event.preventDefault(); window.ReactNativeWebView.postMessage(JSON.stringify({type:'download', url:link.href, name:link.download || 'hob-file'}));
  }, true);
})(); true;`;

function HobApp() {
  const dark = useColorScheme() === 'dark';
  const palette = dark ? { bg: '#191d24', card: '#242932', ink: '#edf0f5', muted: '#a4afbe', border: '#384150', accent: '#82b2ff' }
    : { bg: '#fafafa', card: '#fff', ink: '#17191d', muted: '#687588', border: '#e2e6ec', accent: '#1677ff' };
  const [url, setUrl] = useState(''), [password, setPassword] = useState('');
  const [verified, setVerified] = useState<{ origin: string; info: Instance } | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null), connectionRef = useRef<Connection | null>(null);
  const [bootstrap, setBootstrap] = useState<{ ticket: string } | null>(null), [busy, setBusy] = useState(true), [error, setError] = useState('');
  const [account, setAccount] = useState(false), [pushEnabled, setPushEnabled] = useState(false), [pushMessage, setPushMessage] = useState('');
  const [picker, setPicker] = useState<string | null>(null), pickerBusy = useRef(false), downloadBusy = useRef(false);
  const mediaSelection = useRef<{ id: string; kind: 'library' | 'camera' | 'files' } | null>(null), workspaceReady = useRef(false);
  const [pageLoading, setPageLoading] = useState(false), [webError, setWebError] = useState('');
  const web = useRef<WebView<unknown>>(null), operation = useRef(false), canGoBack = useRef(false), pendingTarget = useRef<{ profile: string; sessionKey: string } | null>(null);
  const setCurrent = useCallback((next: Connection | null) => { connectionRef.current = next; setConnection(next); }, []);
  const connectWorkspace = useCallback(async (current: Connection) => {
    setWebError(''); workspaceReady.current = false;
    const ticket = await deviceRequest<{ ticket: string }>(current, 'session', 'POST');
    if (connectionRef.current?.token === current.token) { setBootstrap(ticket); setPageLoading(true); }
  }, []);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const saved = await SecureStore.getItemAsync(STORAGE);
        if (!saved || !alive) return;
        const current = JSON.parse(saved) as Connection;
        const origin = normalizeInstance(current.origin, __DEV__);
        if (!/^hobm_[a-f0-9]{64}$/.test(current.token) || current.expiresAt <= Date.now()) { await SecureStore.deleteItemAsync(STORAGE); setUrl(origin); return; }
        setCurrent(current); setUrl(origin);
        const instance = await discover(origin);
        if (instance.instanceId !== current.instanceId) throw new LoginExpired('The instance identity changed. Sign in again.');
        const status = await deviceRequest<{ pushEnabled: boolean }>(current, 'device');
        if (alive) { setPushEnabled(status.pushEnabled); await connectWorkspace(current); }
      } catch (error) {
        if (error instanceof LoginExpired || error instanceof SyntaxError) { await SecureStore.deleteItemAsync(STORAGE); if (alive) setCurrent(null); }
        if (alive) setError(errorMessage(error));
      } finally { if (alive) setBusy(false); }
    })();
    return () => { alive = false; };
  }, [connectWorkspace, setCurrent]);
  const handleNotification = useCallback((response: Notifications.NotificationResponse | null) => {
    const current = connectionRef.current; if (!response || !current) return;
    const target = notificationTarget(response.notification.request.content.data || {}, current);
    if (!target) return;
    pendingTarget.current = target;
    if (workspaceReady.current && web.current) {
      pendingTarget.current = null;
      web.current.injectJavaScript(`window.__hobPendingConversation=${JSON.stringify(target)};window.dispatchEvent(new Event('hob:open-conversation'));true;`);
    }
  }, []);
  useEffect(() => {
    const listener = Notifications.addNotificationResponseReceivedListener(handleNotification);
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active' || !connectionRef.current) return;
      const current = connectionRef.current;
      void deviceRequest<{ pushEnabled: boolean }>(current, 'device').then(value => setPushEnabled(value.pushEnabled)).catch(error => { if (error instanceof LoginExpired) { setError(error.message); setBootstrap(null); setCurrent(null); void SecureStore.deleteItemAsync(STORAGE); } });
    });
    return () => { listener.remove(); subscription.remove(); };
  }, [handleNotification, setCurrent]);
  useEffect(() => {
    if (connection) void Notifications.getLastNotificationResponseAsync().then(handleNotification);
  }, [connection, handleNotification]);
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      if (picker) { respond(picker, { files: [] }); setPicker(null); return true; }
      if (account) { setAccount(false); return true; }
      if (connection && canGoBack.current) { web.current?.goBack(); return true; }
      return false;
    });
    return () => listener.remove();
  }, [connection, account, picker]);
  async function verify() {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError('');
    try { const origin = normalizeInstance(url, __DEV__); const info = await discover(origin); setVerified({ origin, info }); setUrl(origin); }
    catch (error) { setError(errorMessage(error)); }
    finally { operation.current = false; setBusy(false); }
  }
  async function signIn() {
    if (!verified || !password || operation.current) return;
    operation.current = true; setBusy(true); setError('');
    try {
      const current = await login(verified.origin, password, Device.deviceName || (Platform.OS === 'ios' ? 'iPhone' : 'Android'));
      await SecureStore.setItemAsync(STORAGE, JSON.stringify(current), { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
      setPassword(''); setPushMessage(''); setPushEnabled(false); setCurrent(current); await connectWorkspace(current);
    } catch (error) { setError(errorMessage(error)); }
    finally { operation.current = false; setBusy(false); }
  }
  async function notifications() {
    if (!connection || operation.current) return;
    operation.current = true; setBusy(true); setPushMessage('');
    try { await enableNotifications(connection); setPushEnabled(true); setPushMessage('This device is registered for reply notifications.'); }
    catch (error) { setPushMessage(errorMessage(error)); }
    finally { operation.current = false; setBusy(false); }
  }
  async function disconnect() {
    const current = connectionRef.current; if (!current || operation.current) return;
    operation.current = true; setBusy(true);
    try {
      // Require server confirmation so a disconnected phone does not silently
      // remain subscribed to private notifications.
      await deviceRequest(current, 'device', 'DELETE');
      await SecureStore.deleteItemAsync(STORAGE); setBootstrap(null); setCurrent(null); setAccount(false); setVerified(null); setPushEnabled(false); setPushMessage(''); setError(''); pendingTarget.current = null;
    } catch (error) { if (error instanceof LoginExpired) { await SecureStore.deleteItemAsync(STORAGE); setBootstrap(null); setCurrent(null); setAccount(false); } else setPushMessage('Could not revoke this device. Reconnect and try again.'); }
    finally { operation.current = false; setBusy(false); }
  }
  function respond(id: string, value: Record<string, unknown>) {
    web.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('hob:native-response',{detail:${JSON.stringify({ id, ...value })}}));true;`);
  }
  async function selectMedia(kind: 'library' | 'camera' | 'files' | null) {
    const id = picker; if (!id || pickerBusy.current) return;
    setPicker(null); if (!kind) { respond(id, { files: [] }); return; }
    pickerBusy.current = true; mediaSelection.current = { id, kind };
    // iOS presents from the current controller; wait until our sheet has
    // actually dismissed before presenting the system media controller.
    if (Platform.OS !== 'ios') await pickSelectedMedia();
  }
  async function pickSelectedMedia() {
    const selection = mediaSelection.current; if (!selection) return;
    mediaSelection.current = null;
    try { respond(selection.id, { files: await pickMedia(selection.kind) }); }
    catch (error) { respond(selection.id, { error: errorMessage(error) }); }
    finally { pickerBusy.current = false; }
  }
  function onMessage(event: WebViewMessageEvent) {
    const current = connectionRef.current; if (!current || !sameInstance(event.nativeEvent.url, current.origin) || event.nativeEvent.data.length > 3_000_000) return;
    try {
      const message = JSON.parse(event.nativeEvent.data);
      if (message.type === 'pick-media' && typeof message.id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(message.id)) {
        if (picker || pickerBusy.current) { respond(message.id, { error: 'A media picker is already open.' }); return; }
        setPicker(message.id);
      }
      if (message.type === 'download' && !downloadBusy.current && typeof message.url === 'string' && typeof message.name === 'string') {
        downloadBusy.current = true;
        void downloadFile(current, message.url, message.name).catch(error => Alert.alert('Download unavailable', errorMessage(error))).finally(() => { downloadBusy.current = false; });
      }
      if (message.type === 'auth-expired') { setBootstrap(null); setError('Your workspace session expired. Reconnect to continue.'); }
      if (message.type === 'open-connection') { setAccount(true); }
    } catch { /* A page message is data, never native code. */ }
  }
  const button = (label: string, action: () => void, secondary = false) => <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={busy} onPress={action} style={[styles.button, { backgroundColor: secondary ? palette.card : palette.ink, borderColor: palette.border, opacity: busy ? 0.5 : 1 }]}><Text style={{ color: secondary ? palette.ink : palette.bg, fontWeight: '600', fontSize: 15 }}>{label}</Text></Pressable>;

  return <SafeAreaView style={[styles.root, { backgroundColor: palette.bg }]} edges={['top', 'bottom']}><StatusBar style={dark ? 'light' : 'dark'} />
    {connection ? <>
      {bootstrap && !webError ? <View style={{ flex: 1 }}><WebView<unknown> key={bootstrap.ticket} ref={web} source={{ html: `<!DOCTYPE html><html><body style="background:${palette.bg}"><form id="b" method="POST" action="${connection.origin}/api/mobile/bootstrap"><input type="hidden" name="ticket" value="${bootstrap.ticket.replace(/"/g, '&quot;')}"></form><script>document.getElementById("b").submit();</script></body></html>`, baseUrl: connection.origin }}
        style={{ backgroundColor: palette.bg }} originWhitelist={[connection.origin]} javaScriptEnabled domStorageEnabled sharedCookiesEnabled thirdPartyCookiesEnabled={false} mixedContentMode="never" allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
        mediaCapturePermissionGrantType="prompt"
        injectedJavaScript={injected} injectedJavaScriptForMainFrameOnly injectedJavaScriptBeforeContentLoadedForMainFrameOnly
        onMessage={onMessage} onNavigationStateChange={state => { canGoBack.current = state.canGoBack; }}
        onShouldStartLoadWithRequest={request => { if (sameInstance(request.url, connection.origin)) return true; if (request.isTopFrame === false) return false; if (/^(https:|mailto:|tel:)/i.test(request.url)) void Linking.openURL(request.url).catch(() => undefined); return false; }}
        onOpenWindow={event => { if (/^https:\/\//i.test(event.nativeEvent.targetUrl)) void Linking.openURL(event.nativeEvent.targetUrl).catch(() => undefined); }}
        onLoadStart={() => { workspaceReady.current = false; setPageLoading(true); }} onLoadEnd={() => { workspaceReady.current = true; setPageLoading(false); if (pendingTarget.current) { const target = pendingTarget.current; pendingTarget.current = null; web.current?.injectJavaScript(`window.__hobPendingConversation=${JSON.stringify(target)};window.dispatchEvent(new Event('hob:open-conversation'));true;`); } }}
        onError={() => { setPageLoading(false); setWebError('The workspace could not be loaded. Check your connection, then reconnect.'); }}
        onHttpError={event => { if (event.nativeEvent.statusCode === 401) setWebError('Your workspace session expired. Reconnect to continue.'); }}
        onContentProcessDidTerminate={() => { setWebError('The workspace was paused by your phone. Reconnect to continue.'); }}
        onRenderProcessGone={() => { workspaceReady.current = false; setWebError('The workspace was paused by your phone. Reconnect to continue.'); }}
      />{pageLoading && <View style={styles.loading}><ActivityIndicator color={palette.accent} /></View>}</View>
        : <View style={styles.center}><Text style={[styles.body, { color: palette.muted }]}>{webError || error || 'Reconnect to your hob workspace.'}</Text>{button(busy ? 'Connecting…' : 'Reconnect workspace', () => { if (!connection) return; setBusy(true); void connectWorkspace(connection).catch(error => setError(errorMessage(error))).finally(() => setBusy(false)); })}</View>}
    </> : <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><ScrollView contentContainerStyle={styles.setup} keyboardShouldPersistTaps="handled">
      <Image source={require('./assets/hob-mark.png')} style={{ width: 84, height: 84, marginBottom: 24 }} accessibilityLabel="hob" />
      <Text style={[styles.title, { color: palette.ink }]}>{verified ? 'Welcome back.' : 'Your hob. Anywhere.'}</Text><Text style={[styles.body, { color: palette.muted }]}>{verified ? 'Your instance is ready. Sign in with its password.' : 'Connect to your own instance to bring your bots, files, and workspace with you.'}</Text>
      {verified ? <><View style={[styles.instance, { borderColor: palette.border, backgroundColor: palette.card }]}><Text style={{ color: palette.accent, fontWeight: '600', marginBottom: 5 }}>hob instance verified</Text><Text style={{ color: palette.muted, fontSize: 13 }}>{verified.origin}</Text></View><TextInput accessibilityLabel="Instance password" placeholder="Instance password" placeholderTextColor={palette.muted} secureTextEntry value={password} onChangeText={setPassword} editable={!busy} textContentType="password" autoComplete="current-password" returnKeyType="go" onSubmitEditing={() => void signIn()} style={[styles.input, { color: palette.ink, borderColor: palette.border, backgroundColor: palette.card }]} />{button(busy ? 'Signing in…' : 'Sign in', () => void signIn())}{button('Use a different instance', () => { setVerified(null); setPassword(''); setError(''); }, true)}</>
        : <><TextInput accessibilityLabel="hob instance URL" placeholder="https://hob.example.com" placeholderTextColor={palette.muted} value={url} onChangeText={setUrl} editable={!busy} autoCapitalize="none" autoCorrect={false} keyboardType="url" textContentType="URL" returnKeyType="go" onSubmitEditing={() => void verify()} style={[styles.input, { color: palette.ink, borderColor: palette.border, backgroundColor: palette.card }]} />{button(busy ? 'Checking instance…' : 'Connect to instance', () => void verify())}<Text style={[styles.small, { color: palette.muted }]}>Your password is requested only after the address identifies itself as hob.</Text></>}
      {error ? <Text accessibilityRole="alert" style={[styles.body, { color: '#d04444' }]}>{error}</Text> : null}
      {busy && <ActivityIndicator color={palette.accent} style={{ marginTop: 12 }} />}
    </ScrollView></KeyboardAvoidingView>}
    <Modal visible={account} transparent animationType="slide" onRequestClose={() => setAccount(false)}><View style={styles.scrim}><View style={[styles.sheet, { backgroundColor: palette.bg }]}><Text style={[styles.sheetTitle, { color: palette.ink }]}>Your connection</Text><Text style={[styles.body, { color: palette.muted }]}>{connection?.origin}</Text><Text style={[styles.small, { color: palette.muted }]}>{pushEnabled ? 'Notifications registered for this device.' : 'Reply notifications are off for this device.'}</Text>
      {button(pushEnabled ? 'Disable notifications' : 'Enable notifications', () => { if (!connection) return; if (!pushEnabled) { void notifications(); return; } setBusy(true); void deviceRequest(connection, 'device/push', 'PUT', { pushToken: null }).then(() => { setPushEnabled(false); setPushMessage('Notifications disabled.'); }).catch(error => setPushMessage(errorMessage(error))).finally(() => setBusy(false)); })}
      {pushEnabled && button('Send a test notification', () => { if (!connection) return; setBusy(true); void deviceRequest(connection, 'device/test', 'POST').then(() => setPushMessage('Test queued. Delivery status is available from the instance.')).catch(error => setPushMessage(errorMessage(error))).finally(() => setBusy(false)); }, true)}
      {pushMessage ? <Text accessibilityLiveRegion="polite" style={[styles.small, { color: palette.muted }]}>{pushMessage}</Text> : null}
      {button('Disconnect this device', () => Alert.alert('Disconnect this device?', 'This signs out and stops its server-side notifications.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Disconnect', style: 'destructive', onPress: () => void disconnect() }]), true)}{button('Done', () => setAccount(false), true)}
    </View></View></Modal>
    <Modal visible={Boolean(picker)} transparent animationType="slide" onDismiss={() => void pickSelectedMedia()} onRequestClose={() => void selectMedia(null)}><View style={styles.scrim}><View style={[styles.sheet, { backgroundColor: palette.bg }]}><Text style={[styles.sheetTitle, { color: palette.ink }]}>Add to your prompt</Text><Text style={[styles.small, { color: palette.muted }]}>Up to 10 files, 5 MB each. Photos are optimized for your bot.</Text>{button('Photos and videos', () => void selectMedia('library'))}{button('Take a photo', () => void selectMedia('camera'), true)}{button('Choose files', () => void selectMedia('files'), true)}{button('Cancel', () => void selectMedia(null), true)}</View></View></Modal>
  </SafeAreaView>;
}
export default function App() { return <SafeAreaProvider><HobApp /></SafeAreaProvider>; }
const styles = StyleSheet.create({
  root: { flex: 1 }, setup: { flexGrow: 1, justifyContent: 'center', padding: 28, maxWidth: 520, width: '100%', alignSelf: 'center' },
  title: { fontSize: 32, fontWeight: '700', letterSpacing: -1, marginBottom: 12 }, body: { fontSize: 15, lineHeight: 23, marginBottom: 22 },
  small: { fontSize: 12, lineHeight: 19, marginBottom: 16 }, input: { minHeight: 56, borderWidth: 1, borderRadius: 18, paddingHorizontal: 17, fontSize: 16, marginBottom: 12 },
  button: { minHeight: 50, borderWidth: 1, borderRadius: 16, alignItems: 'center', justifyContent: 'center', padding: 13, marginBottom: 10 },
  instance: { borderWidth: 1, borderRadius: 18, padding: 16, marginBottom: 18 }, toolbar: { minHeight: 36, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 12 },
  center: { flex: 1, justifyContent: 'center', padding: 28 }, loading: { position: 'absolute', top: 12, alignSelf: 'center', backgroundColor: '#fff', borderRadius: 20, padding: 8 },
  scrim: { flex: 1, backgroundColor: '#0006', justifyContent: 'flex-end' }, sheet: { padding: 24, paddingBottom: 36, borderTopLeftRadius: 28, borderTopRightRadius: 28 }, sheetTitle: { fontSize: 23, fontWeight: '600', marginBottom: 16 },
});

import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, AccessibilityInfo, Appearance, Image, Platform, Pressable, ScrollView, StyleSheet, Text as NativeText, TextInput, useColorScheme, View } from 'react-native';
import type { TextInputProps, TextProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import * as SecureStore from 'expo-secure-store';
import * as Haptics from 'expo-haptics';
import { Icon } from './icons';
import type { IconName } from './icons';

// Aligned 1:1 with web/src/muse.css and web/src/index.css
const light = {
  bg: '#fafafa',
  canvas: '#fafafa',
  card: '#ffffff',
  surface: '#ffffff',
  panel: '#f7f7f8',
  neutral: '#f0f0f0',
  sunken: '#eae8e5',
  hover: '#ebecee',
  hair: '#e2e6ec',
  border: '#e2e6ec',
  edge: '#d0d5dd',
  line: '#e2e6ec',
  ink: '#17191d',
  muted: '#687588',
  faint: '#8792a1',
  soft: '#525866',
  code: '#17191d',
  accent: '#1677ff',
  accentSoft: '#e4eeff',
  accentLine: '#b3d4ff',
  danger: '#b42318',
  bad: '#b42318',
  control: '#e5e5e5',
  selected: '#dedede',
  iconIdle: '#737576',
  incoming: '#f0f0f0',
  outgoing: '#ffffff',
  ok: '#00d65f',
};

const dark = {
  bg: '#060605',
  canvas: '#060605',
  card: '#333536',
  surface: '#333536',
  panel: '#202020',
  neutral: '#202020',
  sunken: '#272829',
  hover: '#2b2c2d',
  hair: '#2b2b2b',
  border: '#2b2b2b',
  edge: '#454647',
  line: '#242424',
  ink: '#f4f4f4',
  muted: '#929394',
  faint: '#686a6b',
  soft: '#dedede',
  code: '#f0f0f0',
  accent: '#008bff',
  accentSoft: '#06233a',
  accentLine: '#12456c',
  danger: '#ffa8a0',
  bad: '#ffa8a0',
  control: '#333536',
  selected: '#272829',
  iconIdle: '#686a6b',
  incoming: '#202020',
  outgoing: '#333536',
  ok: '#00d65f',
};

export type Palette = typeof dark;
export const ThemeContext = createContext<Palette>(dark);
export const usePalette = () => useContext(ThemeContext);
type ThemeMode = 'dark' | 'light' | 'system';
const AppearanceContext = createContext<{ mode: ThemeMode; setMode: (value: ThemeMode) => void }>({ mode: 'dark', setMode: () => undefined });
export const useAppearance = () => useContext(AppearanceContext);

export function NativeTheme({ children }: { children: React.ReactNode }) {
  const scheme = useColorScheme(), [mode, setMode] = useState<ThemeMode>('dark'), palette = mode === 'light' || mode === 'system' && scheme !== 'dark' ? light : dark;
  const [fonts, fontError] = useFonts({ HobRoboto: require('../assets/roboto-variable.ttf') });
  useEffect(() => { if (Platform.OS !== 'web') Appearance.setColorScheme(mode === 'system' ? 'unspecified' : mode); }, [mode]);
  useEffect(() => { if (Platform.OS !== 'web') void SecureStore.getItemAsync('hob.theme.v1').then(value => { if (value === 'light' || value === 'dark' || value === 'system') setMode(value); }).catch(() => undefined); }, []);
  return <AppearanceContext.Provider value={{ mode, setMode: value => { setMode(value); if (Platform.OS !== 'web') void SecureStore.setItemAsync('hob.theme.v1', value).catch(() => undefined); } }}><ThemeContext.Provider value={palette}>{fonts || fontError ? <FeedbackProvider>{children}</FeedbackProvider> : <View style={{ flex: 1, backgroundColor: palette.bg, justifyContent: 'center' }}><ActivityIndicator color={palette.accent} /></View>}</ThemeContext.Provider></AppearanceContext.Provider>;
}

export function AppText({ style, ...props }: TextProps) {
  return <NativeText {...props} style={[{ fontFamily: 'HobRoboto' }, style]} />;
}
const Text = AppText;
const FeedbackContext = createContext<(message: string) => void>(() => undefined);
export const useFeedback = () => useContext(FeedbackContext);

function FeedbackProvider({ children }: { children: React.ReactNode }) {
  const [message, setMessage] = useState(''), p = usePalette(), insets = useSafeAreaInsets();
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(''), 3200); return () => clearTimeout(timer); }, [message]);
  return <FeedbackContext.Provider value={value => { setMessage(value); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined); }}>
    <View style={{ flex: 1 }}>{children}{!!message && <View pointerEvents="none" accessibilityLiveRegion="polite" style={{ position: 'absolute', top: insets.top + 68, left: 24, right: 24, backgroundColor: p.ink, borderRadius: 18, padding: 16, flexDirection: 'row', gap: 12, alignItems: 'center', elevation: 8, zIndex: 999 }}><Icon name="Saved" color={p.bg} size={20} /><Text style={{ color: p.bg, flex: 1, fontWeight: '500' }}>{message}</Text></View>}</View>
  </FeedbackContext.Provider>;
}

export const messageOf = (error: unknown) => error instanceof Error ? error.message.slice(0, 500) : 'Something went wrong. Try again.';

export function RoundButton({ icon, label, onPress, size = 46, iconSize = 22, hasIndicator = false, disabled = false }: { icon: IconName; label: string; onPress: () => void; size?: number; iconSize?: number; hasIndicator?: boolean; disabled?: boolean }) {
  const p = usePalette();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={() => { void Haptics.selectionAsync().catch(() => undefined); onPress(); }} style={({ pressed }) => ({
    width: size, height: size, borderRadius: size / 2, backgroundColor: p.control, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.4 : pressed ? 0.75 : 1, transform: [{ scale: pressed ? 0.96 : 1 }]
  })}>
    <Icon name={icon} size={iconSize} color={p.ink} strokeWidth={1.7} />
    {hasIndicator && <View style={{ position: 'absolute', top: 4, right: 4, width: 8, height: 8, borderRadius: 4, backgroundColor: p.accent }} />}
  </Pressable>;
}

export function Button({ label, onPress, disabled, secondary = false, danger = false, loading = false, icon }: { label: string; onPress: () => void; disabled?: boolean; secondary?: boolean; danger?: boolean; loading?: boolean; icon?: IconName }) {
  const p = usePalette();
  const foreground = secondary ? danger ? p.danger : p.ink : p.bg;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: disabled || loading, busy: loading }} disabled={disabled || loading} onPress={() => { void Haptics.selectionAsync().catch(() => undefined); onPress(); }}
    style={({ pressed }) => [ui.button, { backgroundColor: secondary ? p.panel : danger ? p.danger : p.ink, borderColor: secondary ? p.hair : 'transparent', opacity: disabled && !loading ? 0.4 : pressed ? 0.8 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] }]}>
    {loading ? <ActivityIndicator color={foreground} size="small" /> : icon ? <Icon name={icon} size={18} color={foreground} /> : null}
    <Text style={{ color: secondary ? danger ? p.danger : p.ink : p.bg, fontSize: 15, fontWeight: '600' }}>{label}</Text>
  </Pressable>;
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const p = usePalette(); return <View style={{ gap: 8, marginBottom: 12 }}><Text style={{ color: p.muted, fontSize: 13 }}>{label}</Text><TextInput {...props} accessibilityLabel={label} placeholderTextColor={p.muted}
    style={[ui.input, { backgroundColor: p.panel, borderColor: p.hair, color: p.ink, fontFamily: 'HobRoboto', opacity: props.editable === false ? 0.6 : 1 }, props.multiline && { minHeight: 150, textAlignVertical: 'top' }, props.style]} /></View>;
}

export function Notice({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  const p = usePalette(); return <Text accessibilityRole={error ? 'alert' : undefined} accessibilityLiveRegion="polite" style={{ color: error ? p.danger : p.muted, fontSize: 14, lineHeight: 21, paddingVertical: 8 }}>{children}</Text>;
}

export function Card({ title, subtitle, onPress, children, icon }: { title?: string; subtitle?: string; onPress?: () => void; children?: React.ReactNode; icon?: IconName }) {
  const p = usePalette(); const body = <><View style={[ui.row, { alignItems: 'flex-start' }]}>{icon && <View style={{ width: 40, height: 44, borderRadius: 12, backgroundColor: p.accentSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size={20} color={p.accent} /></View>}<View style={{ flex: 1 }}>{Boolean(title) && <Text style={{ color: p.ink, fontSize: 16, fontWeight: '600', lineHeight: 24 }}>{title}</Text>}{Boolean(subtitle) && <Text numberOfLines={3} style={{ color: p.muted, fontSize: 13, lineHeight: 21, marginTop: 4 }}>{subtitle}</Text>}</View>{onPress && <Icon name="Next" size={18} color={p.muted} />}</View>{children}</>;
  const style = [ui.card, { backgroundColor: p.surface, borderColor: p.hair }];
  return onPress ? <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [...style, { opacity: pressed ? 0.65 : 1 }]}>{body}</Pressable> : <View style={style}>{body}</View>;
}

export function Page({ children, title, loading, error, onRefresh, header, bottomDock }: { children: React.ReactNode; title?: string; loading?: boolean; error?: string; onRefresh?: () => void; header?: React.ReactNode; bottomDock?: React.ReactNode }) {
  const p = usePalette(), insets = useSafeAreaInsets();
  return <View style={{ flex: 1, backgroundColor: p.canvas }}>
    {header}
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 15, paddingTop: header ? 6 : 10, paddingLeft: Math.max(insets.left, 15), paddingRight: Math.max(insets.right, 15), paddingBottom: bottomDock ? insets.bottom + 85 : insets.bottom + 24, flexGrow: 1 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      {!header && (title || onRefresh) && <View style={[ui.row, { marginBottom: 16 }]}>{Boolean(title) && <Text accessibilityRole="header" style={{ color: p.ink, fontSize: 23, lineHeight: 32, fontWeight: '600', flex: 1 }}>{title}</Text>}{onRefresh && <Pressable accessibilityRole="button" accessibilityLabel="Refresh page" onPress={onRefresh} style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}><Icon name="Refresh" size={18} color={p.muted} /></Pressable>}</View>}
      {error ? <ErrorState message={error} retry={onRefresh} /> : null}
      {loading ? <SkeletonCards /> : children}
    </ScrollView>
    {bottomDock}
  </View>;
}

export const ui = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 16, marginBottom: 12, gap: 4 },
  button: { minHeight: 48, borderRadius: 14, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 12, justifyContent: 'center', alignItems: 'center', marginBottom: 10, flexDirection: 'row', gap: 8 },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 14, padding: 14, fontSize: 16 },
});

export function EmptyState({ icon = 'Sparkles', title, description, action }: { icon?: IconName; title: string; description: string; action?: React.ReactNode }) {
  const p = usePalette(); return <View style={{ alignItems: 'center', paddingVertical: 40, paddingHorizontal: 16 }}>
    <View style={{ padding: 15, marginBottom: 14 }}><Icon name={icon} size={30} color={p.muted} strokeWidth={1.5} /></View>
    <Text style={{ color: p.ink, fontWeight: '600', fontSize: 17, textAlign: 'center' }}>{title}</Text><Text style={{ color: p.muted, fontSize: 14, lineHeight: 22, textAlign: 'center', marginTop: 8, marginBottom: 18, maxWidth: 290 }}>{description}</Text>{action}
  </View>;
}

export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  const p = usePalette(); return <View accessibilityRole="alert" style={{ padding: 18, backgroundColor: p.surface, borderWidth: 1, borderColor: p.hair, borderRadius: 20, marginBottom: 16 }}>
    <View style={ui.row}><Icon name="Offline" size={21} color={p.danger} /><Text style={{ color: p.ink, fontWeight: '600', fontSize: 15 }}>Couldn’t load this right now</Text></View><Text style={{ color: p.muted, fontSize: 13, lineHeight: 21, marginTop: 10, marginBottom: retry ? 14 : 0 }}>{message}</Text>
    {retry && <Button label="Try again" secondary icon="Refresh" onPress={retry} />}
  </View>;
}

export function SkeletonCards() {
  const p = usePalette(), opacity = useRef(new Animated.Value(0.6)).current;
  useEffect(() => {
    let animation: Animated.CompositeAnimation | undefined, active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(reduced => {
      if (reduced || !active) return;
      animation = Animated.loop(Animated.sequence([Animated.timing(opacity, { toValue: 1, duration: 850, useNativeDriver: true }), Animated.timing(opacity, { toValue: 0.45, duration: 850, useNativeDriver: true })])); animation.start();
    }); return () => { active = false; animation?.stop(); };
  }, [opacity]);
  return <Animated.View accessibilityLabel="Loading content" accessibilityRole="progressbar" style={{ opacity }}>{[0, 1, 2].map(index => <View key={index} style={[ui.card, { backgroundColor: p.surface, borderColor: p.hair, gap: 14, paddingVertical: 25 }]}><View style={{ width: `${45 + index * 10}%`, height: 13, borderRadius: 6, backgroundColor: p.hair }} /><View style={{ width: '90%', height: 9, borderRadius: 5, backgroundColor: p.hair }} /><View style={{ width: '60%', height: 9, borderRadius: 5, backgroundColor: p.hair }} /></View>)}</Animated.View>;
}

const AVATAR_COLORS = [
  '#6366f1',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#8b5cf6',
  '#14b8a6',
  '#f97316',
];

function getBotColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function BotAvatar({
  name,
  id,
  size = 42,
  uri,
  token,
  showStatus = false,
  status = 'connected',
}: {
  name: string;
  id?: string;
  size?: number;
  uri?: string;
  token?: string;
  showStatus?: boolean;
  status?: 'connected' | 'busy' | 'disconnected';
}) {
  const p = usePalette(), [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [uri]);

  const statusColor = status === 'connected' ? p.ok : status === 'busy' ? '#f59e0b' : p.muted;
  const dotSize = Math.max(9, Math.round(size * 0.22));

  const hasImage = Boolean(uri && !failed);
  const isMain = (id === 'default' || name.toLowerCase() === 'main') && !hasImage;
  const fallbackColor = getBotColor(id || name);
  const initial = (name || 'B').trim().charAt(0).toUpperCase();

  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: p.control, overflow: 'visible', alignItems: 'center', justifyContent: 'center' }}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          overflow: 'hidden',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: isMain ? p.control : fallbackColor,
        }}
      >
        {hasImage ? (
          <Image
            accessibilityLabel={`${name} avatar`}
            source={{ uri, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) }}
            onError={() => setFailed(true)}
            style={{ width: size, height: size }}
            resizeMode="cover"
          />
        ) : isMain ? (
          <Image
            accessibilityLabel={`${name} avatar`}
            source={require('../assets/hob-mark.png')}
            style={{ width: size * 0.82, height: size * 0.82 }}
            resizeMode="contain"
          />
        ) : (
          <Text
            style={{
              color: '#ffffff',
              fontSize: Math.max(12, Math.round(size * 0.44)),
              fontWeight: '700',
              fontFamily: 'HobRoboto',
              textAlign: 'center',
            }}
          >
            {initial}
          </Text>
        )}
      </View>
      {showStatus && (
        <View
          style={{
            position: 'absolute',
            bottom: 0,
            right: 0,
            width: dotSize,
            height: dotSize,
            borderRadius: dotSize / 2,
            backgroundColor: statusColor,
            borderWidth: 2,
            borderColor: p.canvas,
          }}
        />
      )}
    </View>
  );
}

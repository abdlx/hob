import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { DomWebView } from '@expo/dom-webview';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { deviceRequest } from './api';
import { useWorkspace } from './WorkspaceContext';
import { WorkspaceHeader } from './WorkspaceHeader';
import { Button, Notice, useAppearance, usePalette } from './ui';
import type { RootStackParams } from './workspace-types';

export function WebSettings({ route, navigation }: NativeStackScreenProps<RootStackParams, 'WebSettings'>) {
  const { connection } = useWorkspace();
  const palette = usePalette();
  const { setMode } = useAppearance();
  const load = useCallback(() => deviceRequest<{ ticket: string }>(connection, 'session?settings=' + encodeURIComponent(route.params.profile), 'POST'), [connection, route.params.profile]);
  const [ticket, setTicket] = useState(''), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(''); setTicket('');
    void load().then(result => { if (active) setTicket(result.ticket); }).catch(err => { if (active) setError(String(err)); });
    return () => { active = false; };
  }, [load, attempt]);
  return <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: palette.canvas }}>
    <WorkspaceHeader title="Workspace settings" canGoBack onGoBack={() => navigation.goBack()} />
    {error ? <View><Notice>{error}</Notice><Button label="Retry" onPress={() => setAttempt(n => n + 1)} /></View>
      : ticket ? <DomWebView style={{ flex: 1 }} useExpoModulesBridge={false} onMessage={({ nativeEvent }) => {
        if (nativeEvent.data.length > 256) return;
        try {
          const url = new URL(nativeEvent.url);
          if (url.origin !== connection.origin || url.pathname !== '/mobile/settings') return;
          const message = JSON.parse(nativeEvent.data);
          if (message.type === 'open-connection') navigation.push('Connection');
          if (message.type === 'appearance' && ['system', 'light', 'dark'].includes(message.mode)) setMode(message.mode);
        } catch { /* Ignore unknown page messages. */ }
      }} source={{ uri: connection.origin + '/mobile/settings-connect#' + ticket }} />
      : <ActivityIndicator color={palette.accent} />}
  </SafeAreaView>;
}

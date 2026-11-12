import React, { useState } from 'react';
import { ActivityIndicator, Alert, Image, Linking, Platform, Pressable, View } from 'react-native';
import { AppText as Text, usePalette } from './ui';
import { useWorkspace } from './WorkspaceContext';
import { sameInstance } from './connection';
import { downloadFile } from './download';
import { messageOf } from './ui';
import { Icon } from './icons';

export function NativeMarkdown({ content, profile }: { content: string; profile: string }) {
  const p = usePalette(), { connection } = useWorkspace();
  const open = (value: string, name = 'hob-file') => {
    const url = value.startsWith('/api/') ? connection.origin + value : value;
    if (sameInstance(url, connection.origin)) void downloadFile(connection, url, name).catch(error => Alert.alert('File unavailable', messageOf(error)));
    else if (/^(https:|mailto:|tel:)/i.test(url)) void Linking.openURL(url).catch(error => Alert.alert('Link unavailable', messageOf(error)));
  };
  const inline = (text: string): React.ReactNode[] => text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g).map((part, index) => {
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) return <Text key={index} accessibilityRole="link" style={{ color: p.accent, textDecorationLine: 'underline' }} onPress={() => open(link[2], link[1])}>{link[1]}</Text>;
    if (part.startsWith('**') && part.endsWith('**')) return <Text key={index} style={{ fontWeight: '700' }}>{part.slice(2, -2)}</Text>;
    if (part.startsWith('`') && part.endsWith('`')) return <Text key={index} style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, backgroundColor: p.soft }}>{part.slice(1, -1)}</Text>;
    return part;
  });
  const normalized = content.replace(/^(?:MEDIA:|@image:)\s*["'`]?(.+?\.(?:png|jpe?g|gif|webp|avif))["'`]?\s*$/gim, '![]($1)');
  return <View style={{ gap: 10 }}>{normalized.split(/(```[^\n]*\n[\s\S]*?```)/g).filter(Boolean).map((block, index) => {
    if (block.startsWith('```')) {
      const language = /^```([^\n]*)/.exec(block)?.[1] || 'code';
      return <View key={index} style={{ backgroundColor: p.card, borderWidth: 1, borderColor: p.border, borderRadius: 17, overflow: 'hidden' }}><Text style={{ color: p.muted, fontSize: 10, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderColor: p.border }}>{language.toUpperCase()}</Text><Text selectable style={{ color: p.ink, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, lineHeight: 21, padding: 14 }}>{block.replace(/^```[^\n]*\n/, '').replace(/```$/, '')}</Text></View>;
    }
    return <View key={index} style={{ gap: 6 }}>{block.trim().split('\n').map((line, lineIndex) => {
      if (!line.trim()) return <View key={lineIndex} style={{ height: 5 }} />;
      const image = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line.trim());
      if (image) {
        let uri = image[2];
        if (uri.startsWith('/api/')) uri = connection.origin + uri;
        else if (/^(\/|~\/|[a-z]:[\\/])/i.test(uri)) uri = `${connection.origin}/api/hermes/media?${new URLSearchParams({ profile, path: uri })}`;
        if (!sameInstance(uri, connection.origin) && !/^https:\/\//.test(uri)) return <Text key={lineIndex} style={{ color: p.muted }}>Image unavailable</Text>;
        return <NativeImage key={uri} uri={uri} label={image[1] || 'Bot image'} token={sameInstance(uri, connection.origin) ? connection.token : undefined} save={() => open(uri, image[1] || 'hob-image.png')} />;
      }
      const heading = /^(#{1,4})\s+(.+)$/.exec(line), bullet = /^(?:[-*]|\d+\.)\s+(.+)$/.exec(line), quote = /^>\s?(.*)$/.exec(line);
      return <View key={lineIndex} style={{ flexDirection: 'row', gap: 10, ...(quote ? { borderLeftWidth: 2, borderColor: p.accent, paddingLeft: 12 } : {}) }}>{bullet && <Text style={{ color: p.accent, fontSize: 16, lineHeight: 26 }}>•</Text>}<Text selectable style={{ flexShrink: 1, color: quote ? p.muted : p.ink, fontSize: heading ? 24 - heading[1].length * 2 : 15, fontWeight: heading ? '700' : '400', lineHeight: heading ? 29 : 26, ...(heading ? { marginTop: 8, marginBottom: 4 } : {}) }}>{inline(heading?.[2] || bullet?.[1] || quote?.[1] || line)}</Text></View>;
    })}</View>;
  })}</View>;
}
function NativeImage({ uri, label, token, save }: { uri: string; label: string; token?: string; save: () => void }) {
  const p = usePalette(), [state, setState] = useState<'loading' | 'ready' | 'error'>('loading'), [retry, setRetry] = useState(0);
  return <View style={{ borderRadius: 18, borderWidth: 1, borderColor: p.border, backgroundColor: p.card, overflow: 'hidden' }}>
    {state === 'error' ? <Pressable accessibilityRole="button" accessibilityLabel="Retry image" onPress={() => { setState('loading'); setRetry(previous => previous + 1); }} style={{ height: 180, alignItems: 'center', justifyContent: 'center', gap: 12 }}><Icon name="Refresh" color={p.muted} /><Text style={{ color: p.muted, fontSize: 13 }}>Image unavailable. Tap to retry.</Text></Pressable> : <View><Image key={retry} accessibilityLabel={label} source={{ uri, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) }} onLoad={() => setState('ready')} onError={() => setState('error')} style={{ height: 240, width: '100%' }} resizeMode="contain" />{state === 'loading' && <ActivityIndicator color={p.accent} style={{ position: 'absolute', alignSelf: 'center', top: 100 }} />}</View>}
    {state === 'ready' && <Pressable accessibilityRole="button" accessibilityLabel="Save or share image" onPress={save} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderTopWidth: 1, borderColor: p.border }}><Icon name="Download" color={p.accent} size={16} /><Text style={{ color: p.accent, fontSize: 12, fontWeight: '500' }}>Save image</Text></Pressable>}
  </View>;
}

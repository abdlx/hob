import React, { useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Icon } from './icons';
import { AppText as Text, BotAvatar, Button, Field, Notice, usePalette } from './ui';
import { useBotApi, useWorkspace } from './WorkspaceContext';
import type { Bot } from './workspace-types';

export function BotsSidebar({
  currentBotId,
  onSelectBot,
  onOpenSettings,
}: {
  currentBotId: string;
  onSelectBot: (botId: string) => void;
  onOpenSettings: () => void;
}) {
  const p = usePalette(), { bots, connection, refreshBots } = useWorkspace();
  const api = useBotApi('default');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [soul, setSoul] = useState('');
  const [tags, setTags] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const filtered = bots.filter(
    b =>
      b.name.toLowerCase().includes(search.toLowerCase()) ||
      b.id.toLowerCase().includes(search.toLowerCase()) ||
      (b.roleDescription && b.roleDescription.toLowerCase().includes(search.toLowerCase())) ||
      b.tags?.some(tag => tag.toLowerCase().includes(search.toLowerCase()))
  );

  const handleCreate = async () => {
    const cleanName = name.trim().toLowerCase();
    if (!cleanName) return;
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(cleanName)) {
      setError('Name must start with a letter and contain only lowercase letters, digits, dashes, or underscores.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.request('/api/hermes/profiles', 'POST', {
        name: cleanName,
        displayName: displayName.trim() || undefined,
        soul: soul.trim(),
        tags: tags.split(',').map(t => t.trim()).filter(Boolean),
        description: description.trim(),
      });
      await refreshBots();
      setCreateOpen(false);
      setName('');
      setDisplayName('');
      setSoul('');
      setTags('');
      setDescription('');
      onSelectBot(cleanName);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create bot.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.canvas }}>
      {/* Header */}
      <View
        style={{
          paddingHorizontal: 20,
          paddingTop: 16,
          paddingBottom: 10,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontSize: 17, fontWeight: '600', color: p.ink, letterSpacing: -0.3 }}>Bots</Text>
          <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12, backgroundColor: p.panel }}>
            <Text style={{ fontSize: 11, fontWeight: '600', color: p.muted }}>{bots.length}</Text>
          </View>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create new bot"
            onPress={() => {
              void Haptics.selectionAsync().catch(() => undefined);
              setCreateOpen(true);
            }}
            style={({ pressed }) => ({
              width: 38,
              height: 38,
              borderRadius: 19,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: pressed ? p.selected : p.panel,
            })}
          >
            <Icon name="Add" size={19} color={p.ink} strokeWidth={2} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Settings"
            onPress={() => {
              void Haptics.selectionAsync().catch(() => undefined);
              onOpenSettings();
            }}
            style={({ pressed }) => ({
              width: 38,
              height: 38,
              borderRadius: 19,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: pressed ? p.selected : p.panel,
            })}
          >
            <Icon name="Settings" size={20} color={p.ink} strokeWidth={1.8} />
          </Pressable>
        </View>
      </View>

      {/* Search Bar */}
      <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
        <View
          style={{
            height: 40,
            backgroundColor: p.neutral,
            borderRadius: 20,
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 14,
            gap: 10,
          }}
        >
          <Icon name="Search" size={15} color={p.faint} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search bots..."
            placeholderTextColor={p.faint}
            style={{
              flex: 1,
              color: p.ink,
              fontSize: 13,
              fontFamily: 'HobRoboto',
              paddingVertical: 0,
            }}
          />
          {Boolean(search) && (
            <Pressable onPress={() => setSearch('')}>
              <Icon name="Close" size={14} color={p.faint} />
            </Pressable>
          )}
        </View>
      </View>

      {/* Bots list */}
      <FlatList
        data={filtered}
        keyExtractor={item => item.id}
        contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 6, flexGrow: 1 }}
        ListEmptyComponent={
          <View style={{ padding: 32, alignItems: 'center' }}>
            <Text style={{ color: p.muted, fontSize: 14 }}>
              {search ? 'No matching bots found.' : 'No bots available.'}
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const isSelected = item.id === currentBotId;
          const subtitle = isSelected
            ? 'Active now'
            : item.roleDescription || item.lastMessageSnippet || 'Offline';
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={item.name}
              onPress={() => {
                void Haptics.selectionAsync().catch(() => undefined);
                onSelectBot(item.id);
              }}
              style={({ pressed }) => ({
                height: 64,
                paddingHorizontal: 12,
                borderRadius: 18,
                backgroundColor: isSelected ? p.accentSoft : pressed ? p.panel : 'transparent',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                marginBottom: 4,
              })}
            >
              <BotAvatar
                name={item.name}
                id={item.id}
                size={42}
                uri={item.avatarUrl}
                token={connection.token}
                showStatus
                status={isSelected ? 'connected' : 'disconnected'}
              />
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <Text numberOfLines={1} style={{ fontSize: 14.5, fontWeight: '600', color: p.ink }}>
                    {item.name}
                  </Text>
                  {item.tags?.slice(0, 2).map(tag => (
                    <View
                      key={tag}
                      style={{
                        paddingHorizontal: 6,
                        paddingVertical: 2,
                        borderRadius: 6,
                        backgroundColor: p.accentSoft,
                      }}
                    >
                      <Text style={{ fontSize: 10, color: p.accent }}>{tag}</Text>
                    </View>
                  ))}
                </View>
                <Text numberOfLines={1} style={{ fontSize: 12, color: isSelected ? p.muted : p.faint, marginTop: 2 }}>
                  {subtitle}
                </Text>
              </View>
              {isSelected && <Icon name="Check" size={18} color={p.accent} />}
            </Pressable>
          );
        }}
      />

      {/* Create Bot Modal */}
      <Modal
        visible={createOpen}
        transparent
        animationType="slide"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={() => setCreateOpen(false)}
      >
        <View style={{ flex: 1, backgroundColor: '#00000077', justifyContent: 'flex-end' }}>
          <SafeAreaView
            edges={['bottom']}
            style={{
              backgroundColor: p.canvas,
              borderTopLeftRadius: 28,
              borderTopRightRadius: 28,
              maxHeight: '85%',
            }}
          >
            <View style={{ width: 36, height: 4, borderRadius: 2, alignSelf: 'center', backgroundColor: p.hair, marginTop: 10 }} />
            <ScrollView contentContainerStyle={{ padding: 22 }} keyboardShouldPersistTaps="handled">
              <Text style={{ fontSize: 20, fontWeight: '600', color: p.ink, marginBottom: 16 }}>Create new bot</Text>
              {Boolean(error) && <Notice error>{error}</Notice>}
              <Field label="System identifier" placeholder="e.g. coder, analyst" value={name} onChangeText={setName} autoCapitalize="none" autoCorrect={false} editable={!busy} />
              <Field label="Display name" placeholder="Optional public name" value={displayName} onChangeText={setDisplayName} editable={!busy} />
              <Field label="Soul / Personality" placeholder="Instructions that shape behaviour" value={soul} onChangeText={setSoul} multiline editable={!busy} style={{ minHeight: 90 }} />
              <Field label="Tags" placeholder="Comma separated, e.g. code, writing" value={tags} onChangeText={setTags} editable={!busy} />
              <Field label="Role description" placeholder="Short description of role" value={description} onChangeText={setDescription} editable={!busy} />
              <View style={{ gap: 10, marginTop: 8 }}>
                <Button label={busy ? 'Creating…' : 'Create bot'} disabled={busy || !name.trim()} onPress={() => void handleCreate()} />
                <Button label="Cancel" secondary disabled={busy} onPress={() => setCreateOpen(false)} />
              </View>
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>
    </View>
  );
}


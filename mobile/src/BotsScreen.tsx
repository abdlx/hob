import React, { useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { Icon } from './icons';
import { AppText as Text, BotAvatar, Button, Field, Notice, usePalette } from './ui';
import { useBotApi, useWorkspace } from './WorkspaceContext';
import type { Bot, RootStackParams } from './workspace-types';
import { ChatsDrawer } from './ChatsDrawer';
import { MobileDock } from './MobileDock';

export function BotsScreen({ navigation, route }: NativeStackScreenProps<RootStackParams, 'Bots'>) {
  const p = usePalette(), insets = useSafeAreaInsets();
  const { bots, connection, refreshBots } = useWorkspace();
  const api = useBotApi('default');

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [soul, setSoul] = useState('');
  const [tags, setTags] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const currentBotId = route?.params?.profile || bots[0]?.id || 'default';

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshBots();
    } finally {
      setRefreshing(false);
    }
  };

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
      navigation.navigate('Chat', { profile: cleanName });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create bot.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.canvas }}>
      {/* Drawer */}
      <ChatsDrawer
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        profile={currentBotId}
        onSelectSession={session => {
          navigation.push('Chat', {
            profile: currentBotId,
            id: session.id,
            title: session.title,
            readOnly: session.readOnly,
          });
        }}
        onOpenBots={() => setDrawerOpen(false)}
        onOpenSettings={() => navigation.navigate('Settings', { profile: currentBotId })}
      />

      <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1 }}>
        {/* Header matching web 1:1 */}
        <View
          style={{
            paddingHorizontal: 16,
            paddingTop: 8,
            paddingBottom: 10,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          {/* Left: Menu button */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open navigation drawer"
              onPress={() => {
                void Haptics.selectionAsync().catch(() => undefined);
                setDrawerOpen(true);
              }}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                borderRadius: 22,
                backgroundColor: p.control,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.75 : 1,
              })}
            >
              <Icon name="Menu" color={p.ink} size={22} strokeWidth={1.5} />
              <View
                style={{
                  position: 'absolute',
                  top: 3,
                  right: 3,
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: p.accent,
                }}
              />
            </Pressable>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ fontSize: 20, fontWeight: '700', color: p.ink, letterSpacing: -0.4 }}>
                Bots
              </Text>
              <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12, backgroundColor: p.panel }}>
                <Text style={{ fontSize: 12, fontWeight: '600', color: p.muted }}>{bots.length}</Text>
              </View>
            </View>
          </View>

          {/* Right: Add Bot & Settings */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Create new bot"
              onPress={() => {
                void Haptics.selectionAsync().catch(() => undefined);
                setCreateOpen(true);
              }}
              style={({ pressed }) => ({
                width: 40,
                height: 40,
                borderRadius: 20,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: pressed ? p.selected : p.control,
              })}
            >
              <Icon name="Add" size={20} color={p.ink} strokeWidth={2} />
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Settings"
              onPress={() => {
                void Haptics.selectionAsync().catch(() => undefined);
                navigation.navigate('Settings', { profile: currentBotId });
              }}
              style={({ pressed }) => ({
                width: 40,
                height: 40,
                borderRadius: 20,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: pressed ? p.selected : p.control,
              })}
            >
              <Icon name="Settings" size={20} color={p.ink} strokeWidth={1.8} />
            </Pressable>
          </View>
        </View>

        {/* Search Bar */}
        <View style={{ paddingHorizontal: 16, paddingVertical: 6 }}>
          <View
            style={{
              height: 42,
              backgroundColor: p.neutral,
              borderRadius: 21,
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 14,
              gap: 10,
              borderWidth: 1,
              borderColor: p.hair,
            }}
          >
            <Icon name="Search" size={16} color={p.faint} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search bots..."
              placeholderTextColor={p.faint}
              style={{
                flex: 1,
                color: p.ink,
                fontSize: 14,
                paddingVertical: 0,
              }}
            />
            {Boolean(search) && (
              <Pressable onPress={() => setSearch('')}>
                <Icon name="Close" size={16} color={p.faint} />
              </Pressable>
            )}
          </View>
        </View>

        {/* Bots List */}
        <FlatList
          data={filtered}
          keyExtractor={item => item.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 10, flexGrow: 1 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void onRefresh()}
              tintColor={p.accent}
              colors={[p.accent]}
            />
          }
          ListEmptyComponent={
            <View style={{ padding: 48, alignItems: 'center' }}>
              <Icon name="Users" size={40} color={p.muted} />
              <Text style={{ color: p.muted, fontSize: 15, marginTop: 12, textAlign: 'center' }}>
                {search ? 'No matching bots found.' : 'No bots available.'}
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            const subtitle = item.roleDescription || item.lastMessageSnippet || 'Ready';
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Chat with ${item.name}`}
                onPress={() => {
                  void Haptics.selectionAsync().catch(() => undefined);
                  navigation.navigate('Chat', { profile: item.id });
                }}
                style={({ pressed }) => ({
                  minHeight: 72,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  borderRadius: 20,
                  backgroundColor: pressed ? p.panel : p.control,
                  borderWidth: 1,
                  borderColor: p.hair,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 14,
                  marginBottom: 10,
                })}
              >
                <BotAvatar
                  name={item.name}
                  id={item.id}
                  size={50}
                  uri={item.avatarUrl}
                  token={connection.token}
                  showStatus
                  status="connected"
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '600', color: p.ink }}>
                      {item.name}
                    </Text>
                    {item.tags?.slice(0, 2).map(tag => (
                      <View
                        key={tag}
                        style={{
                          paddingHorizontal: 7,
                          paddingVertical: 2,
                          borderRadius: 8,
                          backgroundColor: p.accentSoft,
                        }}
                      >
                        <Text style={{ fontSize: 11, color: p.accent, fontWeight: '500' }}>{tag}</Text>
                      </View>
                    ))}
                  </View>
                  <Text numberOfLines={1} style={{ fontSize: 13, color: p.muted, marginTop: 3 }}>
                    {subtitle}
                  </Text>
                </View>

                <View style={{ paddingLeft: 4 }}>
                  <Icon name="Next" size={16} color={p.muted} />
                </View>
              </Pressable>
            );
          }}
        />

        {/* Bottom Dock Navigation */}
        <MobileDock
          currentTab=""
          onNavigate={tab => {
            navigation.navigate(tab, { profile: currentBotId });
          }}
        />
      </SafeAreaView>

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
            <View
              style={{
                width: 36,
                height: 4,
                borderRadius: 2,
                alignSelf: 'center',
                backgroundColor: p.hair,
                marginTop: 10,
              }}
            />
            <ScrollView contentContainerStyle={{ padding: 22 }} keyboardShouldPersistTaps="handled">
              <Text style={{ fontSize: 20, fontWeight: '600', color: p.ink, marginBottom: 16 }}>
                Create new bot
              </Text>
              {Boolean(error) && <Notice error>{error}</Notice>}
              <Field
                label="System identifier"
                placeholder="e.g. coder, analyst"
                value={name}
                onChangeText={setName}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
              />
              <Field
                label="Display name"
                placeholder="Optional public name"
                value={displayName}
                onChangeText={setDisplayName}
                editable={!busy}
              />
              <Field
                label="Soul / Personality"
                placeholder="Instructions that shape behaviour"
                value={soul}
                onChangeText={setSoul}
                multiline
                editable={!busy}
                style={{ minHeight: 90 }}
              />
              <Field
                label="Tags"
                placeholder="Comma separated, e.g. code, writing"
                value={tags}
                onChangeText={setTags}
                editable={!busy}
              />
              <Field
                label="Role description"
                placeholder="Short description of role"
                value={description}
                onChangeText={setDescription}
                editable={!busy}
              />
              <View style={{ gap: 10, marginTop: 12 }}>
                <Button
                  label={busy ? 'Creating…' : 'Create bot'}
                  disabled={busy || !name.trim()}
                  onPress={() => void handleCreate()}
                />
                <Button label="Cancel" secondary disabled={busy} onPress={() => setCreateOpen(false)} />
              </View>
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>
    </View>
  );
}


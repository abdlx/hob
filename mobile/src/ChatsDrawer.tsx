import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Icon } from './icons';
import { AppText as Text, Button, Field, Notice, usePalette } from './ui';
import { useBotApi } from './WorkspaceContext';
import type { Session } from './workspace-types';

export function ChatsDrawer({
  visible,
  onClose,
  profile,
  activeSessionId,
  onSelectSession,
  onOpenBots,
  onOpenSettings,
}: {
  visible: boolean;
  onClose: () => void;
  profile: string;
  activeSessionId?: string;
  onSelectSession: (session: Session) => void;
  onOpenBots: () => void;
  onOpenSettings: () => void;
}) {
  const p = usePalette(), api = useBotApi(profile);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState('');

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.request<Session[]>('/api/sessions');
      setSessions(list);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (visible) {
      setSearch('');
      setEditing(null);
      void loadSessions();
    }
  }, [visible, loadSessions]);

  const filtered = sessions.filter(
    s =>
      s.title.toLowerCase().includes(search.trim().toLowerCase()) ||
      (s.lastMessageSnippet && s.lastMessageSnippet.toLowerCase().includes(search.trim().toLowerCase()))
  );

  const saveRename = async () => {
    if (!editing || !editing.title.trim()) return;
    setRenameBusy(true);
    setRenameError('');
    try {
      await api.request(`/api/sessions/${encodeURIComponent(editing.id)}/title`, 'POST', {
        title: editing.title.trim(),
      });
      setEditing(null);
      await loadSessions();
    } catch (err: unknown) {
      setRenameError(err instanceof Error ? err.message : 'Could not rename this conversation.');
    } finally {
      setRenameBusy(false);
    }
  };

  const formatDate = (iso?: string) => {
    if (!iso) return '';
    const parsed = Date.parse(iso);
    if (Number.isNaN(parsed)) return '';
    const d = new Date(parsed);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) {
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, flexDirection: 'row', backgroundColor: '#00000066' }}>
        <SafeAreaView
          edges={['top', 'bottom', 'left']}
          style={{
            width: '85%',
            maxWidth: 360,
            backgroundColor: p.canvas,
            borderRightWidth: 1,
            borderColor: p.hair,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Header */}
          <View
            style={{
              paddingHorizontal: 16,
              paddingVertical: 14,
              borderBottomWidth: 1,
              borderColor: p.hair,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Icon name="MessageSquare" size={19} color={p.accent} />
              <Text style={{ fontSize: 16, fontWeight: '600', color: p.ink }}>Conversations</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close conversations"
              onPress={onClose}
              style={{
                width: 32,
                height: 32,
                borderRadius: 16,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="Close" size={18} color={p.faint} />
            </Pressable>
          </View>

          {/* Edit title inline */}
          {editing && (
            <View style={{ padding: 14, borderBottomWidth: 1, borderColor: p.hair, gap: 8 }}>
              <Field
                label="Conversation title"
                value={editing.title}
                onChangeText={text => setEditing({ ...editing, title: text })}
                editable={!renameBusy}
              />
              {Boolean(renameError) && <Notice error>{renameError}</Notice>}
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button label="Save title" disabled={renameBusy || !editing.title.trim()} onPress={() => void saveRename()} />
                <Button label="Cancel" secondary disabled={renameBusy} onPress={() => setEditing(null)} />
              </View>
            </View>
          )}

          {/* Bots navigation row */}
          <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Bots"
              onPress={() => {
                void Haptics.selectionAsync().catch(() => undefined);
                onClose();
                onOpenBots();
              }}
              style={({ pressed }) => ({
                minHeight: 46,
                borderRadius: 12,
                backgroundColor: pressed ? p.selected : p.panel,
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 14,
                gap: 12,
              })}
            >
              <Icon name="Users" size={21} color={p.ink} />
              <Text style={{ color: p.ink, fontSize: 16, fontWeight: '500', flex: 1 }}>Bots</Text>
              <Icon name="Next" size={16} color={p.muted} />
            </Pressable>
          </View>

          {/* Search chats */}
          <View style={{ paddingHorizontal: 14, paddingVertical: 8 }}>
            <View
              style={{
                height: 38,
                backgroundColor: p.neutral,
                borderRadius: 19,
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 12,
                gap: 8,
              }}
            >
              <Icon name="Search" size={15} color={p.faint} />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search chats..."
                placeholderTextColor={p.faint}
                style={{
                  flex: 1,
                  color: p.ink,
                  fontSize: 14,
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

          {/* Sessions List */}
          <FlatList
            data={filtered}
            keyExtractor={item => item.id}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 10, paddingVertical: 6, flexGrow: 1 }}
            ListEmptyComponent={
              <View style={{ padding: 24, alignItems: 'center' }}>
                <Icon name="MessageSquare" size={24} color={p.muted} />
                <Text style={{ color: p.ink, fontSize: 14, fontWeight: '500', marginTop: 10 }}>
                  {search ? 'No matching conversations' : 'No conversations yet'}
                </Text>
                <Text style={{ color: p.muted, fontSize: 12, textAlign: 'center', marginTop: 4 }}>
                  {search ? 'Try another search term.' : 'Start a new chat to begin.'}
                </Text>
              </View>
            }
            renderItem={({ item }) => {
              const active = item.id === activeSessionId;
              return (
                <View style={{ marginBottom: 4 }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={item.title}
                    onPress={() => {
                      void Haptics.selectionAsync().catch(() => undefined);
                      onClose();
                      onSelectSession(item);
                    }}
                    style={({ pressed }) => ({
                      padding: 12,
                      paddingRight: 40,
                      borderRadius: 16,
                      backgroundColor: active ? p.accentSoft : pressed ? p.panel : 'transparent',
                    })}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                      <Text numberOfLines={1} style={{ color: p.ink, fontSize: 14, fontWeight: '500', flex: 1 }}>
                        {item.title}
                      </Text>
                      <Text style={{ color: p.faint, fontSize: 11, flexShrink: 0 }}>
                        {formatDate(item.createdAt)}
                      </Text>
                    </View>
                    {Boolean(item.lastMessageSnippet) && (
                      <Text numberOfLines={1} style={{ color: p.muted, fontSize: 12, marginTop: 3 }}>
                        {item.lastMessageSnippet}
                      </Text>
                    )}
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Rename ${item.title}`}
                    onPress={() => setEditing({ id: item.id, title: item.title })}
                    style={{
                      position: 'absolute',
                      right: 4,
                      top: 10,
                      width: 32,
                      height: 32,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Icon name="Pencil" size={14} color={p.muted} />
                  </Pressable>
                </View>
              );
            }}
          />

          {/* Footer: Settings */}
          <View
            style={{
              padding: 12,
              borderTopWidth: 1,
              borderColor: p.hair,
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Settings"
              onPress={() => {
                void Haptics.selectionAsync().catch(() => undefined);
                onClose();
                onOpenSettings();
              }}
              style={({ pressed }) => ({
                minHeight: 46,
                borderRadius: 12,
                backgroundColor: pressed ? p.selected : 'transparent',
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 12,
                gap: 12,
              })}
            >
              <Icon name="Settings" size={21} color={p.ink} strokeWidth={1.8} />
              <Text style={{ color: p.ink, fontSize: 15, fontWeight: '500' }}>Settings</Text>
            </Pressable>
          </View>
        </SafeAreaView>

        {/* Backdrop tap dismiss */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss drawer"
          onPress={onClose}
          style={{ flex: 1 }}
        />
      </View>
    </Modal>
  );
}


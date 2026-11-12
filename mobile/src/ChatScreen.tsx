import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import type { Attachment, ChatMessage, RootStackParams, Session } from './workspace-types';
import { useBotApi, useResource, useWorkspace } from './WorkspaceContext';
import { AppText as Text, Button, ErrorState, messageOf, Notice, SkeletonCards, ui, usePalette } from './ui';
import { Icon } from './icons';
import { pickMedia } from './media';
import { NativeMarkdown } from './NativeMarkdown';
import { requestId, runBusy } from './navigation';
import { ChatHeader } from './ChatHeader';
import { ChatsDrawer } from './ChatsDrawer';
import { RightPanel } from './RightPanel';
import { MobileDock } from './MobileDock';

interface Run {
  runId?: string;
  status: string;
  revision: string;
  questions?: { id: string; generation: number; question: string; choices: string[] }[];
}
interface Snapshot {
  messages: ChatMessage[];
  run: Run | null;
}
interface Approval {
  id: string;
  description: string;
  commandSnippet?: string;
  status: string;
}

export function ChatScreen({ route, navigation }: NativeStackScreenProps<RootStackParams, 'Chat'>) {
  const { profile, readOnly } = route.params;
  const api = useBotApi(profile);
  const p = usePalette(), insets = useSafeAreaInsets();
  const { bots, connection, refreshBots } = useWorkspace();
  const bot = bots.find(item => item.id === profile);

  const sessionId = useRef(route.params.id);
  const creating = useRef<Promise<string> | null>(null);
  const operation = useRef(false);
  const mounted = useRef(true);
  const stream = useRef<AbortController | null>(null);
  const list = useRef<FlatList<ChatMessage>>(null);
  const input = useRef<React.ComponentRef<typeof TextInput>>(null);
  const follow = useRef(true);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const [draft, setDraft] = useState(route.params.draft || '');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [composerHeight, setComposerHeight] = useState(44);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [activity, setActivity] = useState('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const [live, setLive] = useState<ChatMessage[] | null>(null);
  const [accepted, setAccepted] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [answer, setAnswer] = useState('');
  const [pendingApprovals, setPendingApprovals] = useState<Approval[]>([]);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const load = useCallback(async (signal: AbortSignal): Promise<Snapshot> => {
    const id = route.params.id;
    if (!id) return { messages: [], run: null };
    const messages = await api.request<ChatMessage[]>(`/api/sessions/${encodeURIComponent(id)}/messages`, 'GET', undefined, signal);
    const run = readOnly ? null : (await api.request<{ run: Run | null }>(`/api/sessions/${encodeURIComponent(id)}/run`, 'GET', undefined, signal)).run;
    return { messages, run };
  }, [api, route.params.id, readOnly]);

  const resource = useResource(load, route.params.id ? 5000 : 0);
  const refresh = useRef(resource.refresh);
  refresh.current = resource.refresh;

  // Track pending approvals
  const loadApprovals = useCallback(async () => {
    try {
      const data = await api.request<Approval[]>('/api/security/approvals');
      setPendingApprovals((data || []).filter(item => item.status === 'pending'));
    } catch {
      // ignore
    }
  }, [api]);

  useEffect(() => {
    void loadApprovals();
    const interval = setInterval(loadApprovals, 10000);
    return () => clearInterval(interval);
  }, [loadApprovals]);

  // Working / thinking timer
  const run = resource.data?.run;
  const busy = sending || runBusy(run?.status) || uncertain;

  useEffect(() => {
    if (!busy) {
      setElapsedSeconds(0);
      return;
    }
    const timer = setInterval(() => {
      setElapsedSeconds(prev => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [busy]);

  // Keyboard listeners for drafting state and accurate keyboard avoiding
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener(showEvent, e => {
      setDrafting(true);
      setKeyboardHeight(e.endCoordinates.height);
      setTimeout(() => {
        list.current?.scrollToEnd({ animated: true });
      }, 60);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setDrafting(false);
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Back handler for drawer and panels
  useEffect(() => {
    const backAction = () => {
      if (rightPanelOpen) {
        setRightPanelOpen(false);
        return true;
      }
      if (drawerOpen) {
        setDrawerOpen(false);
        return true;
      }
      return false;
    };
    const handler = BackHandler.addEventListener('hardwareBackPress', backAction);
    return () => handler.remove();
  }, [rightPanelOpen, drawerOpen]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stream.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (resource.data) setUncertain(false);
  }, [resource.data]);

  useEffect(() => {
    if (!draft) setComposerHeight(44);
  }, [draft]);

  async function ensureSession() {
    if (sessionId.current) return sessionId.current;
    creating.current ||= api.request<Session>('/api/sessions', 'POST', { title: 'New Conversation' }).then(session => {
      sessionId.current = session.id;
      if (mounted.current) navigation.setParams({ id: session.id, title: session.title });
      return session.id;
    }).finally(() => {
      creating.current = null;
    });
    return creating.current;
  }

  async function upload(kind: 'camera' | 'library' | 'files') {
    if (operation.current || readOnly) return;
    operation.current = true;
    setUploading(true);
    setError('');
    try {
      const files = await pickMedia(kind);
      if (!files.length || !mounted.current) return;
      if (files.length + attachments.length > 10) throw new Error('Attach up to 10 files per message.');
      const id = await ensureSession();
      for (const file of files) {
        const result = await api.request<Attachment>(`/api/sessions/${encodeURIComponent(id)}/attachments`, 'POST', file);
        if (mounted.current) setAttachments(previous => [...previous, result]);
      }
    } catch (err) {
      if (mounted.current) setError(messageOf(err));
    } finally {
      operation.current = false;
      if (mounted.current) setUploading(false);
    }
  }

  async function send() {
    if (operation.current || busy || readOnly || (!draft.trim() && !attachments.length)) return;
    operation.current = true;
    setSending(true);
    setError('');
    setActivity('Connecting…');
    follow.current = true;
    let attempted = false;
    try {
      const id = await ensureSession();
      if (!mounted.current) return;
      const text = draft.trim();
      const requestKey = requestId();
      const optimistic: ChatMessage = {
        id: requestKey,
        role: 'user',
        content: [text, ...attachments.map(item => `Attached: ${item.name}`)].filter(Boolean).join('\n'),
        timestamp: new Date().toISOString(),
      };
      setLive([...(resource.data?.messages || []), optimistic, { id: `reply-${requestKey}`, role: 'assistant', content: '', timestamp: '', status: 'streaming' }]);
      stream.current = new AbortController();
      attempted = true;
      setDraft('');
      setAttachments([]);
      await api.send(
        id,
        text,
        attachments.map(item => item.id),
        requestKey,
        stream.current.signal,
        (textChunk, replace) => {
          if (mounted.current) {
            setLive(previous => previous?.map((msg, index) => (index === previous.length - 1 ? { ...msg, content: replace ? textChunk : msg.content + textChunk } : msg)) || null);
          }
        },
        value => {
          if (mounted.current) setActivity(value.label);
        },
        value => {
          if (mounted.current) setAccepted(value);
        }
      );
    } catch (err) {
      if (mounted.current) {
        setError(`${messageOf(err)}${attempted ? ' Refresh history before sending again; your bot may still be working.' : ''}`);
        if (attempted) setUncertain(true);
      }
    } finally {
      operation.current = false;
      if (mounted.current) {
        await refresh.current();
        setSending(false);
        setLive(null);
        setAccepted(null);
        setActivity('');
      }
    }
  }

  const resolveApproval = async (id: string, decision: 'approved' | 'rejected') => {
    setApprovingId(id);
    try {
      await api.request(`/api/security/approvals/${encodeURIComponent(id)}`, 'POST', { decision });
      await loadApprovals();
      void resource.refresh();
    } catch (err) {
      Alert.alert('Error', messageOf(err));
    } finally {
      setApprovingId(null);
    }
  };

  const createNewSession = async () => {
    sessionId.current = undefined;
    navigation.push('Chat', { profile });
  };

  const formatMessageTime = (iso?: string) => {
    if (!iso) return '';
    const parsed = Date.parse(iso);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    return '';
  };

  const rawMessages = live || resource.data?.messages || [];
  // Filter out empty messages to prevent multiple useless loading bubbles
  const messages = rawMessages.filter(
    item => (typeof item.content === 'string' && item.content.trim().length > 0) || item.status === 'streaming'
  );
  const question = run?.questions?.[0];

  const initialScrollDone = useRef(false);

  useEffect(() => {
    initialScrollDone.current = false;
    follow.current = true;
  }, [route.params.id]);

  useEffect(() => {
    if (messages.length > 0) {
      const scroll = () => list.current?.scrollToEnd({ animated: false });
      scroll();
      const t1 = setTimeout(scroll, 60);
      const t2 = setTimeout(scroll, 200);
      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
      };
    }
  }, [messages.length, route.params.id]);

  const shortcuts = [
    {
      title: 'Make a little room',
      description: 'Talk through what needs doing.',
      icon: 'MessageCircle' as const,
      action: () => input.current?.focus(),
    },
    {
      title: 'Put it on autopilot',
      description: 'Schedule a task for later.',
      icon: 'CalendarClock' as const,
      action: () => navigation.navigate('Goals', { profile }),
    },
    {
      title: 'See what is taking shape',
      description: 'Browse your agent files.',
      icon: 'FolderOpen' as const,
      action: () => navigation.navigate('Library', { profile }),
    },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: p.canvas }}>
      {/* Drawers and Overlays */}
      <ChatsDrawer
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        profile={profile}
        activeSessionId={sessionId.current}
        onSelectSession={session => {
          sessionId.current = session.id;
          navigation.push('Chat', { profile, id: session.id, title: session.title, readOnly: session.readOnly });
        }}
        onOpenBots={() => {
          setDrawerOpen(false);
          navigation.navigate('Bots', { profile });
        }}
        onOpenSettings={() => navigation.navigate('Settings', { profile })}
      />

      <RightPanel
        visible={rightPanelOpen}
        onClose={() => setRightPanelOpen(false)}
        profile={profile}
        onOpenIdentityEditor={() => {
          setRightPanelOpen(false);
          navigation.navigate('Identity', { profile });
        }}
      />

      <View style={{ flex: 1 }}>
          {/* Top Chat Header 1:1 with web reference header */}
          <ChatHeader
            bot={bot}
            token={connection.token}
            onOpenDrawer={() => setDrawerOpen(true)}
            onOpenRightPanel={() => setRightPanelOpen(true)}
            onNewChat={() => void createNewSession()}
            disabledNewChat={sending}
          />

          {/* Messages list with padding top matching web reference header */}
          <FlatList
            ref={list}
            data={messages}
            keyExtractor={item => item.id}
            style={{ flex: 1 }}
            contentContainerStyle={{
              paddingHorizontal: Math.max(insets.left, insets.right, 16),
              paddingTop: insets.top + 164,
              paddingBottom: 24,
              flexGrow: 1,
            }}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            onScroll={event => {
              const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
              follow.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 100;
            }}
            scrollEventThrottle={100}
            onContentSizeChange={() => {
              if (!initialScrollDone.current || follow.current) {
                list.current?.scrollToEnd({ animated: false });
                initialScrollDone.current = true;
              }
            }}
            onLayout={() => {
              if (messages.length > 0) {
                list.current?.scrollToEnd({ animated: false });
              }
            }}
            initialNumToRender={Math.max(25, messages.length)}
            ListEmptyComponent={
              resource.loading ? (
                <SkeletonCards />
              ) : (
                <View style={{ flex: 1, justifyContent: 'center', paddingVertical: 20 }}>
                  <Text style={{ color: p.ink, fontSize: 30, lineHeight: 36, letterSpacing: -0.6, fontWeight: '600', textAlign: 'center' }}>
                    What can I help you with?
                  </Text>
                  <Text style={{ color: p.muted, marginTop: 12, marginBottom: 24, fontSize: 16, lineHeight: 24, textAlign: 'center' }}>
                    Message {bot?.name || profile}, or choose a place to start.
                  </Text>
                  <View style={{ gap: 10 }}>
                    {shortcuts.map(item => (
                      <Pressable
                        key={item.title}
                        accessibilityRole="button"
                        onPress={() => {
                          void Haptics.selectionAsync().catch(() => undefined);
                          item.action();
                        }}
                        style={({ pressed }) => ({
                          width: '100%',
                          minHeight: 82,
                          padding: 16,
                          backgroundColor: pressed ? p.selected : p.surface,
                          borderWidth: 1,
                          borderColor: p.hair,
                          borderRadius: 20,
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 14,
                        })}
                      >
                        <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: p.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
                          <Icon name={item.icon} color={p.accent} size={20} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: p.ink, fontSize: 14.5, fontWeight: '600', marginBottom: 3 }}>{item.title}</Text>
                          <Text style={{ color: p.muted, fontSize: 12.5, lineHeight: 18 }}>{item.description}</Text>
                        </View>
                        <Icon name="ArrowUpRight" color={p.faint} size={16} />
                      </Pressable>
                    ))}
                  </View>
                </View>
              )
            }
            renderItem={({ item }) => {
              const content = (item.content || '').trim();
              if (!content && item.status !== 'streaming') {
                return null;
              }
              const isUser = item.role === 'user';
              const timeString = formatMessageTime(item.timestamp);
              return (
                <View
                  style={{
                    width: '100%',
                    alignItems: isUser ? 'flex-end' : 'flex-start',
                    marginBottom: 16,
                  }}
                >
                  <View
                    style={{
                      maxWidth: '90%',
                      paddingHorizontal: 16,
                      paddingVertical: isUser ? 10 : 12,
                      borderRadius: 22,
                      borderTopRightRadius: isUser ? 6 : 22,
                      borderTopLeftRadius: isUser ? 22 : 6,
                      backgroundColor: isUser ? p.surface : p.neutral,
                      borderWidth: isUser ? 1 : 0,
                      borderColor: p.hair,
                    }}
                  >
                    {content ? (
                      <NativeMarkdown content={content} profile={profile} />
                    ) : (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 }}>
                        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p.accent }} />
                        <Text style={{ fontSize: 13, color: p.muted }}>Thinking…</Text>
                      </View>
                    )}
                  </View>

                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, paddingHorizontal: 4 }}>
                    {isUser && item.status === 'sending' && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <ActivityIndicator size="small" color={p.accent} />
                        <Text style={{ color: p.faint, fontSize: 11 }}>In progress</Text>
                      </View>
                    )}
                    {Boolean(timeString) && (
                      <Text style={{ color: p.faint, fontSize: 11 }}>{timeString}</Text>
                    )}
                    {!isUser && item.status === 'streaming' && (
                      <Text style={{ color: p.muted, fontSize: 11 }}>Writing…</Text>
                    )}
                  </View>
                </View>
              );
            }}
            ListFooterComponent={
              <View>
                {/* Inline Approvals Prompt */}
                {pendingApprovals.map(approval => (
                  <View
                    key={approval.id}
                    style={{
                      marginVertical: 12,
                      padding: 16,
                      borderRadius: 20,
                      backgroundColor: p.surface,
                      borderWidth: 1,
                      borderColor: p.hair,
                      gap: 8,
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <Icon name="ShieldCheck" size={20} color={p.accent} />
                      <Text style={{ fontSize: 15, fontWeight: '600', color: p.ink, flex: 1 }}>Permission needed</Text>
                    </View>
                    <Text style={{ fontSize: 13, color: p.muted, lineHeight: 19 }}>
                      {approval.description}
                    </Text>
                    {Boolean(approval.commandSnippet) && (
                      <View style={{ backgroundColor: p.panel, padding: 10, borderRadius: 10, marginVertical: 4 }}>
                        <Text style={{ color: p.ink, fontFamily: 'HobRoboto', fontSize: 12 }}>
                          {approval.commandSnippet}
                        </Text>
                      </View>
                    )}
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
                      <Button
                        label="Allow once"
                        disabled={approvingId !== null}
                        loading={approvingId === approval.id}
                        onPress={() => void resolveApproval(approval.id, 'approved')}
                      />
                      <Button
                        label="Deny"
                        secondary
                        disabled={approvingId !== null}
                        onPress={() => void resolveApproval(approval.id, 'rejected')}
                      />
                    </View>
                  </View>
                ))}

                {/* Live working indicator */}
                {busy && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 12, marginLeft: 6 }}>
                    <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: p.accent }} />
                    <Text style={{ fontSize: 13, fontWeight: '500', color: p.ink }}>
                      {activity || `${bot?.name || 'Agent'} is working…`}
                    </Text>
                    {elapsedSeconds > 0 && (
                      <Text style={{ fontSize: 11, color: p.faint }}>
                        {elapsedSeconds >= 60 ? `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s` : `${elapsedSeconds}s`}
                      </Text>
                    )}
                  </View>
                )}

                {/* Bot Clarification Question */}
                {question && (
                  <View style={{ padding: 16, borderRadius: 18, backgroundColor: p.surface, borderWidth: 1, borderColor: p.hair, marginVertical: 10 }}>
                    <Notice>{question.question}</Notice>
                    <FieldAnswer value={answer} onChange={setAnswer} choices={question.choices} />
                    <Button
                      label="Answer bot"
                      disabled={!answer.trim() || uploading}
                      onPress={() => {
                        const id = sessionId.current;
                        if (!id) return;
                        void api.request(`/api/sessions/${encodeURIComponent(id)}/clarify`, 'POST', {
                          promptId: question.id,
                          expectedRevision: run?.revision,
                          answer,
                        }).then(() => {
                          setAnswer('');
                          void resource.refresh();
                        }).catch(err => setError(messageOf(err)));
                      }}
                    />
                  </View>
                )}

                {/* Read-only notification */}
                {readOnly && (
                  <View style={{ padding: 14, borderRadius: 16, backgroundColor: p.panel, marginVertical: 10 }}>
                    <Text style={{ color: p.muted, fontSize: 13 }}>
                      This older API conversation is preserved as history.{' '}
                    </Text>
                    <Pressable onPress={() => void createNewSession()}>
                      <Text style={{ color: p.accent, fontSize: 13, fontWeight: '600', marginTop: 4 }}>
                        Start a new interactive conversation
                      </Text>
                    </Pressable>
                  </View>
                )}
              </View>
            }
          />

          {/* Composer 1:1 with web muse.css */}
          <View
            style={{
              paddingHorizontal: 15,
              paddingTop: 6,
              paddingBottom: keyboardHeight > 0
                ? keyboardHeight + (Platform.OS === 'android' ? 10 : 4)
                : drafting
                ? 14
                : Math.max(insets.bottom, 6),
              backgroundColor: p.canvas,
            }}
          >
            {Boolean(error || resource.error) && (
              <ErrorState message={error || resource.error} retry={() => void resource.refresh()} />
            )}

            {/* Attachments preview chips */}
            {attachments.length > 0 && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {attachments.map(file => (
                  <Pressable
                    key={file.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${file.name}`}
                    onPress={() => setAttachments(prev => prev.filter(item => item.id !== file.id))}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 6,
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      borderRadius: 14,
                      backgroundColor: p.panel,
                      borderWidth: 1,
                      borderColor: p.hair,
                    }}
                  >
                    <Icon name="File" size={14} color={p.accent} />
                    <Text numberOfLines={1} style={{ fontSize: 12, color: p.ink, maxWidth: 160 }}>
                      {file.name}
                    </Text>
                    <Icon name="Close" size={14} color={p.muted} />
                  </Pressable>
                ))}
              </View>
            )}

            {/* Pill-shaped composer container */}
            <View
              style={{
                borderRadius: 28,
                backgroundColor: p.panel,
                minHeight: 46,
                paddingHorizontal: 8,
                paddingVertical: 3,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add attachment"
                disabled={uploading || sending || readOnly}
                onPress={() =>
                  Alert.alert('Add to your prompt', 'Up to 10 files, 5 MB each.', [
                    { text: 'Photos and videos', onPress: () => void upload('library') },
                    { text: 'Take a photo', onPress: () => void upload('camera') },
                    { text: 'Choose files', onPress: () => void upload('files') },
                    { text: 'Cancel', style: 'cancel' },
                  ])
                }
                style={({ pressed }) => ({
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                {uploading ? (
                  <ActivityIndicator color={p.accent} size="small" />
                ) : (
                  <Icon name="Add" color={p.muted} size={20} strokeWidth={2.2} />
                )}
              </Pressable>

              <TextInput
                ref={input}
                accessibilityLabel="Message"
                placeholder="Message..."
                placeholderTextColor={p.faint}
                value={draft}
                onChangeText={setDraft}
                onFocus={() => setDrafting(true)}
                onBlur={() => setDrafting(false)}
                multiline
                maxLength={100000}
                onContentSizeChange={event =>
                  setComposerHeight(Math.max(44, Math.min(160, Math.ceil(event.nativeEvent.contentSize.height))))
                }
                scrollEnabled={composerHeight >= 160}
                underlineColorAndroid="transparent"
                style={{
                  flex: 1,
                  height: composerHeight,
                  color: p.ink,
                  fontFamily: 'HobRoboto',
                  fontSize: 16,
                  lineHeight: 22,
                  paddingHorizontal: 4,
                  paddingVertical: 8,
                  textAlignVertical: 'center',
                }}
              />

              {drafting && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Dismiss keyboard"
                  onPress={() => Keyboard.dismiss()}
                  style={{ width: 36, height: 40, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Icon name="ChevronDown" size={20} color={p.muted} />
                </Pressable>
              )}

              {busy && !draft.trim() && !attachments.length ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Stop generating"
                  onPress={() => {
                    const id = sessionId.current;
                    const runId = accepted || run?.runId;
                    if (!id || !runId) return;
                    void api.request(`/api/sessions/${encodeURIComponent(id)}/abort`, 'POST', { expectedRunId: runId })
                      .then(resource.refresh)
                      .catch(err => setError(messageOf(err)));
                  }}
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    backgroundColor: p.ink,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon name="Stop" color={p.canvas} size={14} fill={p.canvas} />
                </Pressable>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Send message"
                  disabled={busy || uploading || (!draft.trim() && !attachments.length)}
                  onPress={() => void send()}
                  style={({ pressed }) => ({
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    backgroundColor: p.ink,
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: busy || uploading || (!draft.trim() && !attachments.length) ? 0.35 : pressed ? 0.85 : 1,
                  })}
                >
                  <Icon name="ArrowUp" color={p.canvas} size={19} strokeWidth={2.2} />
                </Pressable>
              )}
            </View>
          </View>

          {/* Bottom Dock Navigation */}
          <MobileDock
            currentTab="Chat"
            hidden={drafting || keyboardHeight > 0}
            onNavigate={tab => {
              if (tab !== 'Chat') {
                navigation.navigate(tab, { profile });
              }
            }}
          />
        </View>
    </View>
  );
}

function FieldAnswer({ value, onChange, choices }: { value: string; onChange: (value: string) => void; choices: string[] }) {
  const p = usePalette();
  return (
    <View style={{ marginTop: 6 }}>
      {choices.map(choice => (
        <Button key={choice} label={choice} secondary onPress={() => onChange(choice)} />
      ))}
      <TextInput
        accessibilityLabel="Answer to bot question"
        value={value}
        onChangeText={onChange}
        placeholder="Your answer"
        placeholderTextColor={p.muted}
        style={[ui.input, { color: p.ink, borderColor: p.hair, backgroundColor: p.panel, marginBottom: 10 }]}
      />
    </View>
  );
}

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Share,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Icon } from './icons';
import type { IconName } from './icons';
import { AppText as Text, BotAvatar, Button, Card, Field, Notice, RoundButton, usePalette } from './ui';
import { useBotApi, useWorkspace } from './WorkspaceContext';
import type { Bot, Job } from './workspace-types';

interface Task {
  id: string;
  title: string;
  subtitle?: string;
  status: string;
  timestamp?: string;
}

interface Approval {
  id: string;
  description: string;
  commandSnippet?: string;
  status: string;
  type?: string;
}

const TABS: { id: 'tasks' | 'security' | 'browser' | 'goals' | 'identity'; label: string; icon: IconName }[] = [
  { id: 'tasks', label: 'Activity', icon: 'List' },
  { id: 'security', label: 'Approvals', icon: 'ShieldCheck' },
  { id: 'browser', label: 'Browser', icon: 'Monitor' },
  { id: 'goals', label: 'Scheduled tasks', icon: 'History' },
  { id: 'identity', label: 'Identity', icon: 'Fingerprint' },
];

export function RightPanel({
  visible,
  onClose,
  profile,
  onOpenIdentityEditor,
}: {
  visible: boolean;
  onClose: () => void;
  profile: string;
  onOpenIdentityEditor?: () => void;
}) {
  const p = usePalette(), { bots, connection } = useWorkspace();
  const api = useBotApi(profile);
  const bot = bots.find(b => b.id === profile);
  const name = bot?.name || profile;

  const [activeTab, setActiveTab] = useState<'tasks' | 'security' | 'browser' | 'goals' | 'identity'>('tasks');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [goals, setGoals] = useState<Job[]>([]);
  const [browserTabs, setBrowserTabs] = useState<{ id: string; title: string; url: string }[]>([]);
  const [browserUrl, setBrowserUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [feed, apprs, jobs, bTabs] = await Promise.allSettled([
        api.request<{ items: Task[] } | Task[]>('/api/tasks?format=timeline'),
        api.request<Approval[]>('/api/security/approvals'),
        api.workspace<Job[]>('jobs'),
        api.request<{ tabs: { id: string; title: string; url: string }[] }>(`/api/hermes/browser/tabs?profile=${encodeURIComponent(profile)}`),
      ]);
      if (feed.status === 'fulfilled') {
        const val = feed.value;
        setTasks(Array.isArray(val) ? val : val.items || []);
      }
      if (apprs.status === 'fulfilled') {
        setApprovals(apprs.value || []);
      }
      if (jobs.status === 'fulfilled') {
        setGoals(jobs.value || []);
      }
      if (bTabs.status === 'fulfilled') {
        setBrowserTabs(bTabs.value.tabs || []);
      }
    } finally {
      setLoading(false);
    }
  }, [api, profile]);

  useEffect(() => {
    if (visible) {
      void loadData();
    }
  }, [visible, loadData]);

  const handleShare = async () => {
    try {
      await Share.share({
        title: `hob - ${name}`,
        message: `Chat with ${name} on hob: ${connection.origin}`,
        url: connection.origin,
      });
    } catch {
      // ignore
    }
  };

  const decideApproval = async (id: string, decision: 'approved' | 'rejected') => {
    setActionBusy(id);
    try {
      await api.request(`/api/security/approvals/${encodeURIComponent(id)}`, 'POST', { decision });
      await loadData();
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Could not resolve approval.');
    } finally {
      setActionBusy(null);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent={false}
      animationType="slide"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: p.canvas }} edges={['top', 'bottom', 'left', 'right']}>
        {/* Header matching .hob-agent-profile */}
        <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <RoundButton icon="Close" label="Close agent details" onPress={onClose} iconSize={22} />
            <View style={{ alignItems: 'center', marginTop: 8 }}>
              <BotAvatar name={name} id={profile} size={72} uri={bot?.avatarUrl} token={connection.token} />
              <Text style={{ fontSize: 23, fontWeight: '600', color: p.ink, marginTop: 14 }}>{name}</Text>
              <Text style={{ fontSize: 14, color: p.ok, marginTop: 2 }}>online</Text>
            </View>
            <RoundButton icon="Share" label="Share agent" onPress={() => void handleShare()} iconSize={20} />
          </View>
        </View>

        {/* Segmented bar matching .hob-segments */}
        <View style={{ paddingHorizontal: 16, marginBottom: 16 }}>
          <View
            style={{
              flexDirection: 'row',
              height: 54,
              padding: 5,
              borderRadius: 40,
              backgroundColor: p.panel,
              alignItems: 'center',
            }}
          >
            {TABS.map(tab => {
              const selected = activeTab === tab.id;
              return (
                <Pressable
                  key={tab.id}
                  accessibilityRole="tab"
                  accessibilityLabel={tab.label}
                  accessibilityState={{ selected }}
                  onPress={() => {
                    void Haptics.selectionAsync().catch(() => undefined);
                    setActiveTab(tab.id);
                  }}
                  style={{
                    flex: 1,
                    height: '100%',
                    borderRadius: 30,
                    backgroundColor: selected ? p.selected : 'transparent',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon name={tab.icon} size={22} color={selected ? p.ink : p.iconIdle} strokeWidth={1.8} />
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Tab Content */}
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32, flexGrow: 1 }} keyboardShouldPersistTaps="handled">
          {loading && (
            <View style={{ padding: 24, alignItems: 'center' }}>
              <ActivityIndicator color={p.accent} />
            </View>
          )}

          {!loading && activeTab === 'tasks' && (
            <View style={{ gap: 10 }}>
              <Text style={{ fontSize: 17, fontWeight: '600', color: p.ink, marginBottom: 4 }}>Today</Text>
              {tasks.length === 0 ? (
                <Text style={{ color: p.muted, fontSize: 13, lineHeight: 20 }}>
                  No activity yet. Tasks will appear here as your bot works.
                </Text>
              ) : (
                tasks.map(t => (
                  <View key={t.id} style={{ flexDirection: 'row', gap: 12, paddingVertical: 8, alignItems: 'flex-start' }}>
                    <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: p.panel, alignItems: 'center', justifyContent: 'center' }}>
                      <Icon name="Activity" size={18} color={p.accent} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: p.ink, fontSize: 14.5, fontWeight: '600' }}>{t.title}</Text>
                      {Boolean(t.subtitle) && <Text style={{ color: p.muted, fontSize: 12, marginTop: 2 }}>{t.subtitle}</Text>}
                      <Text style={{ color: p.faint, fontSize: 11, marginTop: 4 }}>{t.status.replace(/_/g, ' ')}</Text>
                    </View>
                  </View>
                ))
              )}
            </View>
          )}

          {!loading && activeTab === 'security' && (
            <View style={{ gap: 12 }}>
              <Text style={{ fontSize: 17, fontWeight: '600', color: p.ink, marginBottom: 4 }}>Approvals history</Text>
              {approvals.length === 0 ? (
                <Text style={{ color: p.muted, fontSize: 13 }}>No approvals yet.</Text>
              ) : (
                approvals.map(a => (
                  <Card key={a.id} title={a.description} subtitle={a.type || a.status}>
                    {Boolean(a.commandSnippet) && (
                      <View style={{ backgroundColor: p.panel, padding: 10, borderRadius: 10, marginVertical: 6 }}>
                        <Text style={{ color: p.ink, fontFamily: 'HobRoboto', fontSize: 12 }}>{a.commandSnippet}</Text>
                      </View>
                    )}
                    {a.status === 'pending' && (
                      <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
                        <Button
                          label="Approve"
                          disabled={actionBusy !== null}
                          loading={actionBusy === a.id}
                          onPress={() => void decideApproval(a.id, 'approved')}
                        />
                        <Button
                          label="Deny"
                          secondary
                          disabled={actionBusy !== null}
                          onPress={() => void decideApproval(a.id, 'rejected')}
                        />
                      </View>
                    )}
                  </Card>
                ))
              )}
            </View>
          )}

          {!loading && activeTab === 'browser' && (
            <View style={{ gap: 12 }}>
              <Text style={{ fontSize: 17, fontWeight: '600', color: p.ink, marginBottom: 4 }}>Browser session</Text>
              <Field
                label="Website URL"
                placeholder="https://example.com"
                value={browserUrl}
                onChangeText={setBrowserUrl}
                autoCapitalize="none"
              />
              <Button
                label="Ask bot to browse"
                disabled={!browserUrl.trim()}
                onPress={() => {
                  Alert.alert('Browse request', `Ask ${name} in chat to inspect ${browserUrl}?`);
                }}
              />
              <Text style={{ fontSize: 14, fontWeight: '600', color: p.ink, marginTop: 8 }}>Remote tabs</Text>
              {browserTabs.length === 0 ? (
                <Text style={{ color: p.muted, fontSize: 13 }}>No remote tabs open.</Text>
              ) : (
                browserTabs.map(tab => (
                  <Card key={tab.id} title={tab.title || tab.url} subtitle={tab.url} />
                ))
              )}
            </View>
          )}

          {!loading && activeTab === 'goals' && (
            <View style={{ gap: 12 }}>
              <Text style={{ fontSize: 17, fontWeight: '600', color: p.ink, marginBottom: 4 }}>Scheduled tasks</Text>
              {goals.length === 0 ? (
                <Text style={{ color: p.muted, fontSize: 13 }}>No scheduled tasks for this bot.</Text>
              ) : (
                goals.map(job => (
                  <Card
                    key={job.id}
                    title={job.name}
                    subtitle={typeof job.schedule === 'string' ? job.schedule : typeof job.schedule?.expr === 'string' ? job.schedule.expr : job.prompt}
                  />
                ))
              )}
            </View>
          )}

          {!loading && activeTab === 'identity' && (
            <View style={{ gap: 12 }}>
              <Text style={{ fontSize: 17, fontWeight: '600', color: p.ink, marginBottom: 4 }}>Identity</Text>
              {Boolean(bot?.roleDescription) && (
                <Text style={{ color: p.muted, fontSize: 13, lineHeight: 20 }}>{bot?.roleDescription}</Text>
              )}
              <Card
                title="Soul"
                subtitle="Personality, values, and behavior (SOUL.md)"
                icon="Identity"
                onPress={onOpenIdentityEditor}
              />
              <Card
                title="Memory"
                subtitle="Long-term memory and context (MEMORY.md)"
                icon="Memory"
                onPress={onOpenIdentityEditor}
              />
              {bot?.model && (
                <Card
                  title="Model"
                  subtitle={bot.model}
                  icon="Bot"
                />
              )}
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}


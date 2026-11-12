import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Image, Pressable, Switch, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useNavigation, usePreventRemove } from '@react-navigation/native';
import type { FilePreview, Job, LibraryEntry, RootStackParams, Session, Skill } from './workspace-types';
import { useBotApi, useResource, useWorkspace } from './WorkspaceContext';
import { AppText as Text, BotAvatar, Button, Card, EmptyState, ErrorState, Field, messageOf, Notice, Page, SkeletonCards, ui, useAppearance, useFeedback, usePalette } from './ui';
import { downloadFile } from './download';
import { requestId } from './navigation';
import { Icon } from './icons';
import { WorkspaceHeader } from './WorkspaceHeader';
import { MobileDock } from './MobileDock';
import { ChatsDrawer } from './ChatsDrawer';
import { BotFilterChips } from './BotFilterChips';
import { workspaceApi } from './workspace-api';

type Props<N extends keyof RootStackParams> = NativeStackScreenProps<RootStackParams, N>;

function useUnsavedChanges(dirty: boolean, busy: boolean) {
  const navigation = useNavigation();
  usePreventRemove(dirty && !busy, ({ data }) => Alert.alert('Discard your changes?', 'Your edits haven’t been saved yet.', [
    { text: 'Keep editing', style: 'cancel' }, { text: 'Discard changes', style: 'destructive', onPress: () => navigation.dispatch(data.action) },
  ]));
}

function useWrite() {
  const feedback = useFeedback();
  const lock = useRef(false), mounted = useRef(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const act = async (work: () => Promise<unknown>, success?: string) => {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await work(); if (success) feedback(success); } catch (err) { if (mounted.current) setError(messageOf(err)); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  return { busy, error, act };
}

function useRead<T>(profile: string, operation: string, query: Record<string, string> = {}, poll = 0) {
  const api = useBotApi(profile), queryKey = JSON.stringify(query);
  const load = useCallback((signal: AbortSignal) => api.workspace<T>(operation, 'GET', undefined, JSON.parse(queryKey), signal), [api, operation, queryKey]);
  return { ...useResource(load, poll), api };
}

const scheduleText = (job: Job) => typeof job.schedule === 'string' ? job.schedule : String(job.schedule?.display || job.schedule?.value || job.schedule?.expr || '');

interface SessionWithBot extends Session {
  botId: string;
  botName?: string;
  avatarUrl?: string;
}

export function ConversationsScreen({ route, navigation }: Props<'Conversations'>) {
  const { profile } = route.params;
  const { bots, connection } = useWorkspace();
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async (signal: AbortSignal): Promise<SessionWithBot[]> => {
    if (selectedBotId !== null) {
      const api = workspaceApi(connection, selectedBotId);
      const list = await api.request<Session[]>('/api/sessions', 'GET', undefined, signal);
      const bot = bots.find(b => b.id === selectedBotId);
      return (list || []).map(item => ({
        ...item,
        botId: selectedBotId,
        botName: bot?.name || selectedBotId,
        avatarUrl: bot?.avatarUrl,
      }));
    }
    const results = await Promise.allSettled(
      bots.map(async bot => {
        const api = workspaceApi(connection, bot.id);
        const list = await api.request<Session[]>('/api/sessions', 'GET', undefined, signal);
        return (list || []).map(item => ({
          ...item,
          botId: bot.id,
          botName: bot.name,
          avatarUrl: bot.avatarUrl,
        }));
      })
    );
    const combined = results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
    combined.sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''));
    return combined;
  }, [selectedBotId, connection, bots]);

  const state = useResource(load);
  const activeProfile = selectedBotId || profile;
  const sessions = state.data?.filter(item =>
    `${item.title} ${item.lastMessageSnippet || ''} ${item.botName || ''}`.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Page
      title="Conversations"
      {...state}
      onRefresh={state.refresh}
      header={<WorkspaceHeader canGoBack onGoBack={() => navigation.goBack()} title="Conversations" />}
    >
      <BotFilterChips selectedBotId={selectedBotId} onSelectBot={setSelectedBotId} includeAll={true} />
      <Button label="New conversation" onPress={() => navigation.push('Chat', { profile: activeProfile })} />
      <Field label="Search conversations" value={search} onChangeText={setSearch} placeholder="Find a conversation" />
      {sessions?.map(session => (
        <Card
          key={`${session.botId}:${session.id}`}
          title={session.title}
          subtitle={`${session.botName ? `${session.botName} · ` : ''}${session.lastMessageSnippet || (session.readOnly ? 'Read-only history' : 'Open conversation')}`}
          onPress={() => navigation.push('Chat', { profile: session.botId, id: session.id, title: session.title, readOnly: session.readOnly })}
        />
      ))}
      {sessions?.length === 0 && (
        <EmptyState
          icon={search ? 'Search' : 'Conversations'}
          title={search ? 'No conversations found' : 'No conversations yet'}
          description={search ? 'Try a different name or clear your search.' : 'Start a conversation with your bots. Your chats will appear here.'}
        />
      )}
    </Page>
  );
}

interface Task {
  id: string;
  title: string;
  subtitle?: string;
  status: string;
  timestamp?: string;
  origin?: { profile: string; sessionId: string };
  botId?: string;
  botName?: string;
  avatarUrl?: string;
}
interface Approval {
  id: string;
  description: string;
  commandSnippet?: string;
  status: string;
  botId?: string;
}

export function ActivityScreen({ route, navigation }: Props<'Activity'>) {
  const { profile } = route.params;
  const { bots, connection } = useWorkspace();
  const write = useWrite();
  const [drawer, setDrawer] = useState(false);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    if (selectedBotId !== null) {
      const api = workspaceApi(connection, selectedBotId);
      const bot = bots.find(b => b.id === selectedBotId);
      const [feed, approvals] = await Promise.all([
        api.request<{ items: Task[]; warnings?: string[] } | Task[]>('/api/tasks?format=timeline', 'GET', undefined, signal),
        api.request<Approval[]>('/api/security/approvals', 'GET', undefined, signal).catch(() => [] as Approval[]),
      ]);
      const rawItems = Array.isArray(feed) ? feed : (feed.items || []);
      const items: Task[] = rawItems.map(item => ({
        ...item,
        botId: selectedBotId,
        botName: bot?.name || selectedBotId,
        avatarUrl: bot?.avatarUrl,
      }));
      const warnings = Array.isArray(feed) ? [] : (feed.warnings || []);
      return { items, warnings, approvals: approvals.map(a => ({ ...a, botId: selectedBotId })) };
    }

    // "All bots" selected
    const results = await Promise.allSettled(
      bots.map(async bot => {
        const api = workspaceApi(connection, bot.id);
        const [feed, approvals] = await Promise.all([
          api.request<{ items: Task[]; warnings?: string[] } | Task[]>('/api/tasks?format=timeline', 'GET', undefined, signal),
          api.request<Approval[]>('/api/security/approvals', 'GET', undefined, signal).catch(() => [] as Approval[]),
        ]);
        const rawItems = Array.isArray(feed) ? feed : (feed.items || []);
        const items: Task[] = rawItems.map(item => ({
          ...item,
          botId: bot.id,
          botName: bot.name,
          avatarUrl: bot.avatarUrl,
        }));
        const warnings = Array.isArray(feed) ? [] : (feed.warnings?.map(w => `${bot.name}: ${w}`) || []);
        return { items, warnings, approvals: approvals.map(a => ({ ...a, botId: bot.id })) };
      })
    );

    const items: Task[] = [];
    const warnings: string[] = [];
    const approvals: Approval[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        items.push(...r.value.items);
        warnings.push(...r.value.warnings);
        approvals.push(...r.value.approvals);
      }
    }
    return { items, warnings, approvals };
  }, [selectedBotId, connection, bots]);

  const state = useResource(load, 10000);
  const activeProfile = selectedBotId || profile;

  return (
    <>
      <ChatsDrawer
        visible={drawer}
        onClose={() => setDrawer(false)}
        profile={activeProfile}
        onSelectSession={s => navigation.push('Chat', { profile: activeProfile, id: s.id, title: s.title, readOnly: s.readOnly })}
        onOpenBots={() => {
          setDrawer(false);
          navigation.navigate('Bots', { profile: activeProfile });
        }}
        onOpenSettings={() => navigation.navigate('Settings', { profile: activeProfile })}
      />
      <Page
        title="Activity"
        {...state}
        onRefresh={state.refresh}
        header={<WorkspaceHeader title="Activity" onOpenDrawer={() => setDrawer(true)} />}
        bottomDock={<MobileDock currentTab="Activity" onNavigate={tab => navigation.navigate(tab, { profile: activeProfile })} />}
      >
        <BotFilterChips selectedBotId={selectedBotId} onSelectBot={setSelectedBotId} includeAll={true} />
        {Boolean(write.error) && <Notice error>{write.error}</Notice>}
        {state.data?.warnings?.map(warning => <Notice key={warning}>{warning}</Notice>)}
        {state.data?.approvals.filter(item => item.status === 'pending').map(item => (
          <Card key={item.id} title="Approval requested" subtitle={`${item.botId ? `${item.botId} · ` : ''}${item.description}`}>
            {Boolean(item.commandSnippet) && <Notice>{item.commandSnippet}</Notice>}
            <Button
              label="Approve once"
              disabled={write.busy}
              onPress={() => Alert.alert('Approve this action?', item.description, [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Approve once',
                  onPress: () => void write.act(async () => {
                    const api = workspaceApi(connection, item.botId || activeProfile);
                    await api.request(`/api/security/approvals/${encodeURIComponent(item.id)}`, 'POST', { decision: 'approved' });
                    await state.refresh();
                  }),
                },
              ])}
            />
            <Button
              label="Reject"
              secondary
              disabled={write.busy}
              onPress={() => void write.act(async () => {
                const api = workspaceApi(connection, item.botId || activeProfile);
                await api.request(`/api/security/approvals/${encodeURIComponent(item.id)}`, 'POST', { decision: 'rejected' });
                await state.refresh();
              })}
            />
          </Card>
        ))}
        {state.data?.items.map(item => (
          <Card
            key={`${item.botId || ''}:${item.id}`}
            title={item.title}
            subtitle={`${item.botName ? `${item.botName} · ` : ''}${item.status.replace(/_/g, ' ')}${item.subtitle ? ` · ${item.subtitle}` : ''}`}
            onPress={() => navigation.push('Chat', { profile: item.origin?.profile || item.botId || activeProfile, id: item.origin?.sessionId || item.id, title: item.title })}
          />
        ))}
        {state.data?.items.length === 0 && (
          <EmptyState
            icon="Activity"
            title="No activity yet"
            description={selectedBotId ? 'This bot has no recent tasks or activity.' : 'Your bots’ tasks, progress, and completed work will appear here.'}
          />
        )}
      </Page>
    </>
  );
}

interface JobWithBot extends Job {
  botId: string;
  botName?: string;
}

export function GoalsScreen({ route, navigation }: Props<'Goals'>) {
  const { profile } = route.params;
  const { bots, connection } = useWorkspace();
  const write = useWrite(), p = usePalette();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);

  const load = useCallback(async (signal: AbortSignal): Promise<JobWithBot[]> => {
    if (selectedBotId !== null) {
      const api = workspaceApi(connection, selectedBotId);
      const bot = bots.find(b => b.id === selectedBotId);
      const jobs = await api.workspace<Job[]>('jobs', 'GET', undefined, undefined, signal);
      return (jobs || []).map(j => ({ ...j, botId: selectedBotId, botName: bot?.name || selectedBotId }));
    }
    const results = await Promise.allSettled(
      bots.map(async bot => {
        const api = workspaceApi(connection, bot.id);
        const jobs = await api.workspace<Job[]>('jobs', 'GET', undefined, undefined, signal);
        return (jobs || []).map(j => ({ ...j, botId: bot.id, botName: bot.name }));
      })
    );
    return results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
  }, [selectedBotId, connection, bots]);

  const state = useResource(load);
  const activeProfile = selectedBotId || profile;

  return (
    <>
      <ChatsDrawer
        visible={drawer}
        onClose={() => setDrawer(false)}
        profile={activeProfile}
        onSelectSession={s => navigation.push('Chat', { profile: activeProfile, id: s.id, title: s.title, readOnly: s.readOnly })}
        onOpenBots={() => {
          setDrawer(false);
          navigation.navigate('Bots', { profile: activeProfile });
        }}
        onOpenSettings={() => navigation.navigate('Settings', { profile: activeProfile })}
      />
      <Page
        title="Goals"
        error={state.error}
        onRefresh={state.refresh}
        header={<WorkspaceHeader title="Goals" onOpenDrawer={() => setDrawer(true)} />}
        bottomDock={<MobileDock currentTab="Goals" onNavigate={tab => navigation.navigate(tab, { profile: activeProfile })} />}
      >
        <BotFilterChips selectedBotId={selectedBotId} onSelectBot={setSelectedBotId} includeAll={true} />
        <View style={[ui.row, { marginBottom: 12 }]}>
          <View style={{ width: 23, height: 23, borderRadius: 12, backgroundColor: p.panel, alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: p.ok }} />
          </View>
          <Text style={{ color: p.ok, fontSize: 17, fontWeight: '600', flex: 1 }}>Tracking</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New goal"
            onPress={() => navigation.push('Goal', { profile: activeProfile })}
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="Add" color={p.muted} size={22} />
          </Pressable>
        </View>
        {Boolean(write.error) && <Notice error>{write.error}</Notice>}
        {state.loading && <SkeletonCards />}
        {state.data?.map(job => {
          const jobBot = job.botId || activeProfile;
          const api = workspaceApi(connection, jobBot);
          return (
            <View key={`${job.botId}:${job.id}`} style={{ marginBottom: 16 }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 9 }}>
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityLabel={`${job.enabled === false || job.state === 'paused' ? 'Resume' : 'Pause'} ${job.name}`}
                  accessibilityState={{ checked: job.enabled !== false && job.state !== 'paused', disabled: write.busy }}
                  disabled={write.busy}
                  onPress={() => void write.act(async () => {
                    await api.workspace(`jobs/${encodeURIComponent(job.id)}/${job.enabled === false || job.state === 'paused' ? 'resume' : 'pause'}`, 'POST', {});
                    await state.refresh();
                  })}
                  style={{ minHeight: 44, width: 24, paddingTop: 5 }}
                >
                  <View style={{ width: 21, height: 21, borderWidth: 2, borderColor: p.muted, borderRadius: 5, alignItems: 'center', justifyContent: 'center' }}>
                    {(job.enabled === false || job.state === 'paused') && <Icon name="Pause" color={p.muted} size={13} />}
                  </View>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={job.name}
                  onPress={() => setExpanded(expanded === job.id ? null : job.id)}
                  style={{ flex: 1, paddingTop: 4, minHeight: 48 }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <Text style={{ color: p.ink, fontSize: 17, lineHeight: 23 }}>{job.name}</Text>
                    {Boolean(job.botName) && (
                      <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, backgroundColor: p.accentSoft }}>
                        <Text style={{ fontSize: 11, color: p.accent }}>{job.botName}</Text>
                      </View>
                    )}
                  </View>
                  <Text numberOfLines={2} style={{ color: p.muted, fontSize: 15, lineHeight: 21, marginTop: 4 }}>
                    {job.prompt || scheduleText(job)}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Actions for ${job.name}`}
                  onPress={() => setExpanded(expanded === job.id ? null : job.id)}
                  style={{ width: 36, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Icon name="More" color={p.muted} size={21} />
                </Pressable>
              </View>
              {expanded === job.id && (
                <View style={{ marginLeft: 33, backgroundColor: p.panel, borderRadius: 14, padding: 15, marginTop: 8 }}>
                  <Notice>{scheduleText(job)}{job.next_run_at ? `\nNext run: ${new Date(job.next_run_at).toLocaleString()}` : ''}</Notice>
                  <Button label="Edit goal" secondary onPress={() => navigation.push('Goal', { profile: jobBot, job })} />
                </View>
              )}
            </View>
          );
        })}
        {state.data?.length === 0 && (
          <EmptyState
            icon="Goals"
            title="No scheduled goals"
            description="Create a goal to have your bots run instructions on your schedule."
          />
        )}
        <View style={{ borderTopWidth: 1, borderColor: p.panel, marginTop: 10, paddingTop: 20 }}>
          <Text style={{ color: p.ink, fontSize: 17, fontWeight: '600', marginBottom: 10 }}>Create a goal</Text>
          {(['Health', 'Relationships', 'Finance', 'Career', 'Interests', 'Productivity', 'Something else'] as const).map(label => (
            <Pressable
              key={label}
              accessibilityRole="button"
              onPress={() => navigation.push('Chat', { profile: activeProfile, draft: label === 'Something else' ? 'set a goal ' : `set a goal for ${label.toLowerCase()} ` })}
              style={[ui.row, { minHeight: 58 }]}
            >
              <Icon name={label === 'Something else' ? 'Goals' : label} color={p.muted} size={24} />
              <Text style={{ color: p.ink, fontSize: 17, flex: 1 }}>{label}</Text>
              <Icon name="Add" color={p.muted} size={22} />
            </Pressable>
          ))}
        </View>
      </Page>
    </>
  );
}

export function GoalScreen({ route, navigation }: Props<'Goal'>) {
  const { profile, job } = route.params, api = useBotApi(profile), write = useWrite();
  const [name, setName] = useState(job?.name || ''), [prompt, setPrompt] = useState(job?.prompt || ''), [schedule, setSchedule] = useState(job ? scheduleText(job) : '0 9 * * *');
  const [preview, setPreview] = useState<{ schedule: string; nextRun: string; timezone: string } | null>(null);
  useUnsavedChanges(name !== (job?.name || '') || prompt !== (job?.prompt || '') || schedule !== (job ? scheduleText(job) : '0 9 * * *'), write.busy);
  return (
    <Page
      title={job ? 'Edit goal' : 'New goal'}
      error={write.error}
      header={<WorkspaceHeader canGoBack onGoBack={() => navigation.goBack()} title={job ? 'Edit goal' : 'New goal'} />}
    >
      <Field label="Goal name" value={name} onChangeText={setName} editable={!write.busy} />
      <Field label="Instructions" value={prompt} onChangeText={setPrompt} multiline editable={!write.busy} />
      <Field label="Schedule" value={schedule} onChangeText={value => { setSchedule(value); setPreview(null); }} placeholder="0 9 * * *" autoCapitalize="none" editable={!write.busy} />
      <Notice>Use a cron expression, an interval such as 30m, or an ISO date. Preview uses your bot’s timezone.</Notice>
      <Button
        label="Preview schedule"
        secondary
        disabled={write.busy || !schedule.trim()}
        onPress={() => void write.act(async () => {
          const result = await api.workspace<{ nextRun: string; timezone: string }>('schedule-preview', 'POST', { schedule: schedule.trim() });
          setPreview({ ...result, schedule: schedule.trim() });
        })}
      />
      {preview && <Notice>Next run: {new Date(preview.nextRun).toLocaleString()} · {preview.timezone}</Notice>}
      <Button
        label={write.busy ? 'Saving…' : 'Save goal'}
        loading={write.busy}
        disabled={write.busy || !name.trim() || !prompt.trim() || preview?.schedule !== schedule.trim()}
        onPress={() => void write.act(async () => {
          await api.workspace(job ? `jobs/${encodeURIComponent(job.id)}` : 'jobs', job ? 'PUT' : 'POST', { name: name.trim(), prompt: prompt.trim(), schedule: schedule.trim() });
          navigation.goBack();
        }, 'Goal saved')}
      />
      {job && (
        <>
          <Button
            label="Run now"
            secondary
            disabled={write.busy}
            onPress={() => Alert.alert('Run this goal now?', job.name, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Run now', onPress: () => void write.act(async () => { await api.workspace(`jobs/${encodeURIComponent(job.id)}/trigger`, 'POST', {}); navigation.goBack(); }) },
            ])}
          />
          <Button
            label="Delete goal"
            secondary
            danger
            disabled={write.busy}
            onPress={() => Alert.alert('Delete this goal?', job.name, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Delete', style: 'destructive', onPress: () => void write.act(async () => { await api.workspace(`jobs/${encodeURIComponent(job.id)}`, 'DELETE'); navigation.goBack(); }) },
            ])}
          />
        </>
      )}
    </Page>
  );
}

interface LibraryFileWithBot extends LibraryEntry {
  botId: string;
  botName?: string;
}

export function LibraryScreen({ route, navigation }: Props<'Library'>) {
  const { profile, path = '' } = route.params;
  const { bots, connection } = useWorkspace();
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [search, setSearch] = useState(''), [tab, setTab] = useState<'Artifacts' | 'Media'>('Artifacts'), [options, setOptions] = useState(false), [limit, setLimit] = useState(12);
  const p = usePalette();
  const [drawer, setDrawer] = useState(false);

  const load = useCallback(async (signal: AbortSignal) => {
    if (selectedBotId !== null) {
      const api = workspaceApi(connection, selectedBotId);
      const bot = bots.find(b => b.id === selectedBotId);
      const res = await api.workspace<{ entries: LibraryEntry[]; deliveries?: { status: string }[] }>('files', 'GET', undefined, { path }, signal);
      const entries: LibraryFileWithBot[] = (res.entries || []).map(e => ({ ...e, botId: selectedBotId, botName: bot?.name || selectedBotId }));
      return { entries, deliveries: res.deliveries };
    }
    const results = await Promise.allSettled(
      bots.map(async bot => {
        const api = workspaceApi(connection, bot.id);
        const res = await api.workspace<{ entries: LibraryEntry[]; deliveries?: { status: string }[] }>('files', 'GET', undefined, { path }, signal);
        const entries: LibraryFileWithBot[] = (res.entries || []).map(e => ({ ...e, botId: bot.id, botName: bot.name }));
        return { entries, deliveries: res.deliveries };
      })
    );
    const entries: LibraryFileWithBot[] = [];
    const deliveries: { status: string }[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        entries.push(...r.value.entries);
        if (r.value.deliveries) deliveries.push(...r.value.deliveries);
      }
    }
    return { entries, deliveries };
  }, [selectedBotId, connection, bots, path]);

  const state = useResource(load);
  const activeProfile = selectedBotId || profile;

  const media = (name: string) => /\.(png|jpe?g|gif|webp|avif|mp4|webm|mov|mp3|wav|ogg)$/i.test(name);
  const entries = state.data?.entries
    .filter(item =>
      item.name.toLowerCase().includes(search.toLowerCase()) &&
      (item.directory ? tab === 'Artifacts' : tab === 'Media' ? media(item.name) : !media(item.name))
    )
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, undefined, { numeric: true }));

  return (
    <>
      <ChatsDrawer
        visible={drawer}
        onClose={() => setDrawer(false)}
        profile={activeProfile}
        onSelectSession={s => navigation.push('Chat', { profile: activeProfile, id: s.id, title: s.title, readOnly: s.readOnly })}
        onOpenBots={() => {
          setDrawer(false);
          navigation.navigate('Bots', { profile: activeProfile });
        }}
        onOpenSettings={() => navigation.navigate('Settings', { profile: activeProfile })}
      />
      <Page
        title="Library"
        header={<WorkspaceHeader title="Library" canGoBack={Boolean(path)} onGoBack={() => navigation.goBack()} onOpenDrawer={() => setDrawer(true)} onOptions={() => setOptions(!options)} />}
        bottomDock={<MobileDock currentTab="Library" onNavigate={tab => navigation.navigate(tab, { profile: activeProfile })} />}
      >
        <BotFilterChips selectedBotId={selectedBotId} onSelectBot={setSelectedBotId} includeAll={true} />
        <View style={{ flexDirection: 'row', width: '100%', height: 54, padding: 5, borderRadius: 40, backgroundColor: p.panel, marginBottom: 20 }}>
          {(['Artifacts', 'Media'] as const).map(item => (
            <Pressable
              key={item}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === item }}
              onPress={() => { setTab(item); setSearch(''); setLimit(12); }}
              style={{ borderRadius: 30, backgroundColor: tab === item ? p.selected : 'transparent', flex: 1, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={{ color: p.ink, fontSize: 15, fontWeight: '500' }}>{item}</Text>
            </Pressable>
          ))}
        </View>
        {options && (
          <View style={{ backgroundColor: p.panel, padding: 16, borderRadius: 18, marginBottom: 18 }}>
            <Field label="Search files" value={search} onChangeText={value => { setSearch(value); setLimit(12); }} placeholder="Search files in this folder" />
            <Button label="Refresh library" icon="Refresh" secondary onPress={() => void state.refresh()} />
          </View>
        )}
        {Boolean(path) && <Text style={{ color: p.muted, fontSize: 12, marginBottom: 12 }}>Workspace / {path}</Text>}
        {Boolean(state.error) && <ErrorState message={state.error} retry={() => void state.refresh()} />}
        {state.data?.deliveries?.some(item => item.status === 'failed') && <Notice error>Some result files could not be published. Their originals were preserved; ask the bot to save them in its workspace.</Notice>}
        {state.loading ? (
          <SkeletonCards />
        ) : (
          <View style={tab === 'Media' ? { flexDirection: 'row', flexWrap: 'wrap', gap: 2, borderRadius: 20, overflow: 'hidden' } : undefined}>
            {entries?.slice(0, limit).map(file => (
              <Pressable
                key={`${file.botId}:${file.path}`}
                accessibilityRole="button"
                accessibilityLabel={`${file.directory ? 'Open folder' : 'Preview'} ${file.name}`}
                onPress={() => file.directory ? navigation.push('Library', { profile: file.botId, path: file.path }) : navigation.push('File', { profile: file.botId, file })}
                style={tab === 'Media' ? { width: '32.9%', aspectRatio: 1, backgroundColor: p.panel } : { flexDirection: 'row', minHeight: 64, alignItems: 'center', gap: 14 }}
              >
                {tab === 'Media' ? (
                  <LibraryArtwork profile={file.botId} file={file} />
                ) : (
                  <>
                    <Icon name={file.directory ? 'Folder' : 'File'} size={31} color={p.ink} strokeWidth={1} />
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={{ color: p.ink, fontSize: 17, lineHeight: 23 }}>{file.name}</Text>
                      <Text style={{ color: p.muted, fontSize: 14, lineHeight: 20 }}>
                        {file.botName ? `${file.botName} · ` : ''}{file.directory ? 'Folder' : file.name.split('.').pop()?.toUpperCase()}
                      </Text>
                    </View>
                  </>
                )}
              </Pressable>
            ))}
          </View>
        )}
        {entries?.length === 0 && <EmptyState icon={search ? 'Search' : 'Folder'} title={search ? 'No matching files' : `No ${tab === 'Media' ? 'media' : 'artifacts'} in this folder yet`} description={search ? 'Try another name or choose a different file type.' : 'Files your bots create will appear here.'} />}
        {entries && entries.length > limit && <Button label="Show more" secondary onPress={() => setLimit(value => value + 12)} />}
      </Page>
    </>
  );
}

function LibraryArtwork({ profile, file }: { profile: string; file: LibraryEntry }) {
  const state = useRead<FilePreview>(profile, 'file', { path: file.path }), p = usePalette();
  return state.data?.mimeType.match(/^image\/(png|jpeg|gif|webp|avif|bmp)$/) ? (
    <Image accessibilityLabel={file.name} source={{ uri: state.data.dataUrl }} style={{ width: '100%', height: '100%' }} />
  ) : (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name="File" color={p.muted} size={28} />
    </View>
  );
}

export function FileScreen({ route, navigation }: Props<'File'>) {
  const { profile, file } = route.params, state = useRead<FilePreview>(profile, 'file', { path: file.path }), { connection } = useWorkspace(), write = useWrite(), p = usePalette();
  const preview = state.data;
  let text: string | null = null;
  if (preview && (preview.mimeType.startsWith('text/') || /\.(json|md|csv|tsv|py|js|ts|tsx|jsx|ya?ml|sql|toml)$/i.test(file.name))) {
    try {
      const encoded = preview.dataUrl.slice(preview.dataUrl.indexOf(',') + 1);
      text = /;base64,/.test(preview.dataUrl) ? new TextDecoder().decode(Uint8Array.from(atob(encoded), char => char.charCodeAt(0))) : decodeURIComponent(encoded);
    } catch {
      text = 'Text preview unavailable.';
    }
  }
  return (
    <Page
      title={file.name}
      {...state}
      header={<WorkspaceHeader canGoBack onGoBack={() => navigation.goBack()} title={file.name} />}
    >
      <Button
        label={write.busy ? 'Preparing file…' : 'Save or share file'}
        icon="Download"
        loading={write.busy}
        disabled={write.busy}
        onPress={() => void write.act(() => downloadFile(connection, connection.origin + state.api.path('download', { path: file.path }), file.name))}
      />
      {Boolean(write.error) && <Notice error>{write.error}</Notice>}
      {preview?.mimeType.match(/^image\/(png|jpeg|gif|webp|avif|bmp)$/) ? (
        <Image accessibilityLabel={file.name} source={{ uri: preview.dataUrl }} style={{ width: '100%', height: 350 }} resizeMode="contain" />
      ) : text !== null ? (
        <Text selectable style={{ color: p.ink, fontSize: 14, lineHeight: 23 }}>{text}</Text>
      ) : preview && (
        <Notice>Use Save or share to open this file with an app on your phone.</Notice>
      )}
    </Page>
  );
}

interface SkillWithBot extends Skill {
  botId: string;
  botName?: string;
}

export function SkillsScreen({ route, navigation }: Props<'Skills'>) {
  const { profile } = route.params;
  const { bots, connection } = useWorkspace();
  const write = useWrite(), [search, setSearch] = useState(''), p = usePalette();
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);

  const load = useCallback(async (signal: AbortSignal): Promise<SkillWithBot[]> => {
    if (selectedBotId !== null) {
      const api = workspaceApi(connection, selectedBotId);
      const bot = bots.find(b => b.id === selectedBotId);
      const list = await api.workspace<Skill[]>('skills', 'GET', undefined, undefined, signal);
      return (list || []).map(s => ({ ...s, botId: selectedBotId, botName: bot?.name || selectedBotId }));
    }
    const results = await Promise.allSettled(
      bots.map(async bot => {
        const api = workspaceApi(connection, bot.id);
        const list = await api.workspace<Skill[]>('skills', 'GET', undefined, undefined, signal);
        return (list || []).map(s => ({ ...s, botId: bot.id, botName: bot.name }));
      })
    );
    return results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
  }, [selectedBotId, connection, bots]);

  const state = useResource(load);
  const activeProfile = selectedBotId || profile;

  return (
    <Page
      title="Skills"
      {...state}
      onRefresh={state.refresh}
      header={<WorkspaceHeader canGoBack onGoBack={() => navigation.goBack()} title="Skills" />}
    >
      <BotFilterChips selectedBotId={selectedBotId} onSelectBot={setSelectedBotId} includeAll={true} />
      <Button label="Create skill" icon="Add" onPress={() => navigation.push('Skill', { profile: activeProfile })} />
      <Field label="Search skills" value={search} onChangeText={setSearch} placeholder="Find a skill" />
      {Boolean(write.error) && <Notice error>{write.error}</Notice>}
      {state.data?.filter(skill => `${skill.name} ${skill.description || ''} ${skill.botName || ''}`.toLowerCase().includes(search.toLowerCase())).map(skill => {
        const api = workspaceApi(connection, skill.botId);
        return (
          <Card
            key={`${skill.botId}:${skill.name}`}
            title={skill.name}
            subtitle={`${skill.botName ? `${skill.botName} · ` : ''}${skill.description || ''}`}
            onPress={() => navigation.push('Skill', { profile: skill.botId, name: skill.name })}
          >
            <View style={[ui.row, { justifyContent: 'space-between', marginTop: 8 }]}>
              <Text style={{ color: p.muted }}>{skill.enabled ? 'Enabled' : 'Disabled'}</Text>
              <Switch
                accessibilityLabel={`Enable ${skill.name}`}
                value={skill.enabled}
                disabled={write.busy}
                onValueChange={enabled => void write.act(async () => {
                  await api.workspace('skill/toggle', 'PUT', { name: skill.name, enabled });
                  await state.refresh();
                })}
              />
            </View>
          </Card>
        );
      })}
      {state.data?.length === 0 && <EmptyState icon="Skills" title="No skills installed" description="Skills appear here once installed or proposed." />}
      {Boolean(search) && state.data?.length !== 0 && !state.data?.some(skill => `${skill.name} ${skill.description || ''}`.toLowerCase().includes(search.toLowerCase())) && (
        <EmptyState icon="Search" title="No matching skills" description="Try another name or clear your search." />
      )}
    </Page>
  );
}

export function SkillScreen({ route, navigation }: Props<'Skill'>) {
  const { profile, name: existing } = route.params, api = useBotApi(profile), write = useWrite();
  const [name, setName] = useState(existing || ''), [content, setContent] = useState(''), [ready, setReady] = useState(!existing), [loadError, setLoadError] = useState(''), [baseline, setBaseline] = useState('');
  const load = useCallback(async () => {
    if (!existing) return;
    try {
      const result = await api.workspace<{ content: string }>('skill', 'GET', undefined, { name: existing });
      setContent(result.content);
      setBaseline(result.content);
      setReady(true);
      setLoadError('');
    } catch (error) {
      setLoadError(messageOf(error));
    }
  }, [api, existing]);
  useEffect(() => { void load(); }, [load]);
  useUnsavedChanges(ready && (content !== baseline || name !== (existing || '')), write.busy);
  return (
    <Page
      title={existing || 'New skill'}
      error={write.error || loadError}
      loading={!ready && !loadError}
      onRefresh={existing ? load : undefined}
      header={<WorkspaceHeader canGoBack onGoBack={() => navigation.goBack()} title={existing || 'New skill'} />}
    >
      <Field label="Skill name" value={name} onChangeText={setName} editable={!existing && !write.busy} autoCapitalize="none" />
      <Field label="SKILL.md content" value={content} onChangeText={setContent} multiline editable={ready && !write.busy} style={{ minHeight: 340 }} />
      <Button
        label={write.busy ? 'Saving…' : 'Save skill'}
        loading={write.busy}
        disabled={!ready || write.busy || !name.trim() || !content.trim()}
        onPress={() => void write.act(async () => {
          await api.workspace('skill', existing ? 'PUT' : 'POST', { name: name.trim(), content });
          navigation.goBack();
        }, 'Skill saved')}
      />
    </Page>
  );
}

interface LearningNode {
  id: string;
  label: string;
  kind: string;
  memorySource?: string;
  botId?: string;
  botName?: string;
}

export function MemoryScreen({ route, navigation }: Props<'Memory'>) {
  const { profile } = route.params;
  const { bots, connection } = useWorkspace();
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    if (selectedBotId !== null) {
      const api = workspaceApi(connection, selectedBotId);
      const bot = bots.find(b => b.id === selectedBotId);
      const res = await api.workspace<{ nodes: LearningNode[] }>('learning', 'GET', undefined, undefined, signal);
      const nodes: LearningNode[] = (res.nodes || []).map(n => ({ ...n, botId: selectedBotId, botName: bot?.name || selectedBotId }));
      return { nodes };
    }
    const results = await Promise.allSettled(
      bots.map(async bot => {
        const api = workspaceApi(connection, bot.id);
        const res = await api.workspace<{ nodes: LearningNode[] }>('learning', 'GET', undefined, undefined, signal);
        const nodes: LearningNode[] = (res.nodes || []).map(n => ({ ...n, botId: bot.id, botName: bot.name }));
        return { nodes };
      })
    );
    const nodes: LearningNode[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') nodes.push(...r.value.nodes);
    }
    return { nodes };
  }, [selectedBotId, connection, bots]);

  const state = useResource(load);
  const activeProfile = selectedBotId || profile;

  return (
    <Page
      title="Memory"
      {...state}
      onRefresh={state.refresh}
      header={<WorkspaceHeader canGoBack onGoBack={() => navigation.goBack()} title="Memory" />}
    >
      <BotFilterChips selectedBotId={selectedBotId} onSelectBot={setSelectedBotId} includeAll={true} />
      <Button label="Review memory proposals" secondary onPress={() => navigation.push('Workshop', { profile: activeProfile })} />
      {state.data?.nodes.filter(node => node.kind === 'memory').map(node => (
        <Card
          key={`${node.botId}:${node.id}`}
          title={node.label}
          subtitle={`${node.botName ? `${node.botName} · ` : ''}${node.memorySource === 'profile' ? 'USER.md' : 'MEMORY.md'}`}
          onPress={() => navigation.push('MemoryEntry', { profile: node.botId || activeProfile, id: node.id, label: node.label })}
        />
      ))}
      {state.data && !state.data.nodes.some(node => node.kind === 'memory') && (
        <EmptyState icon="Memory" title="No saved memories yet" description="Ask your bot to remember something in chat." />
      )}
    </Page>
  );
}

export function MemoryEntryScreen({ route, navigation }: Props<'MemoryEntry'>) {
  const { profile, id, label } = route.params, state = useRead<{ content: string }>(profile, 'learning/node', { id }), write = useWrite();
  const [draft, setDraft] = useState<string | null>(null);
  useUnsavedChanges(draft !== null && draft !== state.data?.content, write.busy);
  return (
    <Page
      title={label}
      {...state}
      error={write.error || state.error}
      header={<WorkspaceHeader canGoBack onGoBack={() => navigation.goBack()} title={label} />}
    >
      <Field label="Memory entry" value={draft ?? state.data?.content ?? ''} onChangeText={setDraft} multiline editable={Boolean(state.data) && !write.busy} style={{ minHeight: 300 }} />
      <Button label="Save memory" disabled={write.busy || !state.data || !(draft ?? state.data.content).trim()} onPress={() => void write.act(async () => { await state.api.workspace('learning/node', 'PUT', { id, content: draft ?? state.data?.content }); navigation.goBack(); })} />
      <Button label="Delete memory" secondary danger disabled={write.busy || !state.data} onPress={() => Alert.alert('Delete this memory?', 'This cannot be undone.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => void write.act(async () => { await state.api.workspace('learning/node', 'DELETE', { id }); navigation.goBack(); }) }])} />
    </Page>
  );
}

interface Queue {
  items: { id: string; summary: string; revision: string }[];
  nextOffset: number | null;
  unresolvedDecisions?: number;
}
interface QueueItemWithBot {
  id: string;
  summary: string;
  revision: string;
  botId: string;
  botName?: string;
}

export function WorkshopScreen({ route, navigation }: Props<'Workshop'>) {
  const { profile } = route.params;
  const { bots, connection } = useWorkspace();
  const [subsystem, setSubsystem] = useState<'skills' | 'memory'>('skills'), [offset, setOffset] = useState(0);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);

  const load = useCallback(async (signal: AbortSignal) => {
    if (selectedBotId !== null) {
      const api = workspaceApi(connection, selectedBotId);
      const bot = bots.find(b => b.id === selectedBotId);
      const q = await api.workspace<Queue>(`reviews/${subsystem}`, 'GET', undefined, { offset: String(offset) }, signal);
      const items: QueueItemWithBot[] = (q.items || []).map(i => ({ ...i, botId: selectedBotId, botName: bot?.name || selectedBotId }));
      return { items, nextOffset: q.nextOffset, unresolvedDecisions: q.unresolvedDecisions };
    }
    const results = await Promise.allSettled(
      bots.map(async bot => {
        const api = workspaceApi(connection, bot.id);
        const q = await api.workspace<Queue>(`reviews/${subsystem}`, 'GET', undefined, { offset: String(offset) }, signal);
        const items: QueueItemWithBot[] = (q.items || []).map(i => ({ ...i, botId: bot.id, botName: bot.name }));
        return { items, nextOffset: q.nextOffset, unresolvedDecisions: q.unresolvedDecisions };
      })
    );
    const items: QueueItemWithBot[] = [];
    let unresolvedDecisions = 0;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        items.push(...r.value.items);
        if (r.value.unresolvedDecisions) unresolvedDecisions += r.value.unresolvedDecisions;
      }
    }
    return { items, nextOffset: null, unresolvedDecisions };
  }, [selectedBotId, connection, bots, subsystem, offset]);

  const state = useResource(load);
  const activeProfile = selectedBotId || profile;

  return (
    <>
      <ChatsDrawer
        visible={drawer}
        onClose={() => setDrawer(false)}
        profile={activeProfile}
        onSelectSession={s => navigation.push('Chat', { profile: activeProfile, id: s.id, title: s.title, readOnly: s.readOnly })}
        onOpenBots={() => {
          setDrawer(false);
          navigation.navigate('Bots', { profile: activeProfile });
        }}
        onOpenSettings={() => navigation.navigate('Settings', { profile: activeProfile })}
      />
      <Page
        title="Workshop"
        {...state}
        onRefresh={state.refresh}
        header={<WorkspaceHeader title="Workshop" onOpenDrawer={() => setDrawer(true)} />}
        bottomDock={<MobileDock currentTab="Workshop" onNavigate={tab => navigation.navigate(tab, { profile: activeProfile })} />}
      >
        <BotFilterChips selectedBotId={selectedBotId} onSelectBot={setSelectedBotId} includeAll={true} />
        <View style={ui.row}>
          <View style={{ flex: 1 }}>
            <Button label="Skill proposals" secondary={subsystem !== 'skills'} onPress={() => { setSubsystem('skills'); setOffset(0); }} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label="Memory writes" secondary={subsystem !== 'memory'} onPress={() => { setSubsystem('memory'); setOffset(0); }} />
          </View>
        </View>
        <Notice>Review proposed changes before deciding what your bots keep.</Notice>
        {!!state.data?.unresolvedDecisions && <Notice error>A previous decision is unconfirmed. Inspect its current state in your instance before making another decision.</Notice>}
        {state.data?.items.map(item => (
          <Card
            key={`${item.botId}:${item.id}`}
            title={item.summary || item.id}
            subtitle={`${item.botName ? `${item.botName} · ` : ''}Pending review`}
            onPress={() => navigation.push('Review', { profile: item.botId, subsystem, id: item.id, revision: item.revision })}
          />
        ))}
        {state.data?.items.length === 0 && <EmptyState icon="Workshop" title="All caught up" description={`New ${subsystem === 'skills' ? 'skill proposals' : 'memory suggestions'} will arrive here. You decide what stays.`} />}
        {!!offset && <Button label="First page" secondary onPress={() => setOffset(0)} />}
        {state.data?.nextOffset != null && <Button label="Next page" secondary onPress={() => setOffset(state.data!.nextOffset!)} />}
      </Page>
    </>
  );
}

export function ReviewScreen({ route, navigation }: Props<'Review'>) {
  const { profile, subsystem, id, revision } = route.params;
  const state = useRead<{ id: string; revision: string; summary: string; diff: string; stale?: boolean; team?: { version: number; profile: string; session: string; kind: string } }>(profile, `reviews/${subsystem}/${encodeURIComponent(id)}`), write = useWrite(), p = usePalette();
  const [confirmed, setConfirmed] = useState(false), detail = state.data;
  useEffect(() => { setConfirmed(false); }, [detail?.revision]);
  const valid = detail?.id === id && /^[a-f0-9]{64}$/.test(detail.revision) && typeof detail.diff === 'string' && (!detail.team || detail.team.version === 1 && detail.team.profile === profile && ['user', 'relay'].includes(detail.team.kind));
  const decide = (action: 'approve' | 'reject') => {
    if (!valid || !detail) return;
    Alert.alert(action === 'approve' ? 'Apply this reviewed revision?' : 'Reject this proposal?', detail.summary, [{ text: 'Cancel', style: 'cancel' }, { text: action === 'approve' ? 'Apply revision' : 'Reject', onPress: () => void write.act(async () => {
      const result = await state.api.workspace<{ ok: boolean }>(`reviews/${subsystem}`, 'POST', { id, revision: detail.revision, action, requestId: requestId(), confirm: true, ...(detail.team && action === 'approve' ? { confirmPrivatePromotion: true } : {}) });
      if (result.ok !== true) throw new Error('The bot did not confirm this decision. Refresh before retrying.'); navigation.goBack();
    }) }]);
  };
  return <Page title={detail?.summary || 'Review proposal'} {...state} error={write.error || state.error} header={<WorkspaceHeader canGoBack onGoBack={() => navigation.goBack()} title="Review proposal" />}>
    {detail && !valid && <Notice error>This proposal’s identity or revision could not be verified.</Notice>}
    {valid && detail && <><Notice>Revision {detail.revision}{detail.revision !== revision ? '\nThe proposal changed. Review the current diff below.' : ''}</Notice><Text selectable style={{ color: p.ink, fontSize: 13, lineHeight: 21 }}>{detail.diff}</Text>
      {detail.stale && <Notice error>This proposal is stale. Request a fresh proposal before applying it.</Notice>}
      {detail.team && <Notice>This change will persist privately for this bot across future chats.</Notice>}
      <View style={[ui.row, { paddingVertical: 16 }]}><Switch accessibilityLabel="I reviewed this revision" value={confirmed} onValueChange={setConfirmed} /><Text style={{ color: p.ink, flex: 1 }}>I reviewed this exact revision{detail.team ? ' and want it to persist across chats' : ''}.</Text></View>
      <Button label="Approve reviewed revision" disabled={write.busy || !confirmed || detail.stale} onPress={() => decide('approve')} />
      <Button label="Reject proposal" secondary disabled={write.busy} onPress={() => decide('reject')} /></>}
  </Page>;
}

export function IdentityScreen({ route, navigation }: Props<'Identity'>) {
  const { profile } = route.params;
  const { bots } = useWorkspace();
  const [selectedBotId, setSelectedBotId] = useState<string | null>(profile);
  const activeProfile = selectedBotId || profile;
  const state = useRead<{ content: string }>(activeProfile, 'soul');
  const write = useWrite(), [draft, setDraft] = useState<string | null>(null), [saved, setSaved] = useState(false);
  useUnsavedChanges(draft !== null && draft !== state.data?.content && !saved, write.busy);

  return (
    <Page
      title="Identity"
      {...state}
      error={write.error || state.error}
      header={<WorkspaceHeader canGoBack onGoBack={() => navigation.goBack()} title="Identity" />}
    >
      <BotFilterChips selectedBotId={selectedBotId} onSelectBot={id => { setSelectedBotId(id || profile); setDraft(null); setSaved(false); }} includeAll={false} />
      <Notice>Shape how this bot thinks and behaves.</Notice>
      <Field label="SOUL.md" value={draft ?? state.data?.content ?? ''} onChangeText={value => { setDraft(value); setSaved(false); }} multiline editable={Boolean(state.data) && !write.busy} style={{ minHeight: 360 }} />
      <Button label="Save identity" disabled={!state.data || write.busy || draft === null} onPress={() => void write.act(async () => { await state.api.workspace('soul', 'PUT', { content: draft }); setSaved(true); })} />
      {Boolean(saved) && <Notice>Identity saved.</Notice>}
    </Page>
  );
}

interface ToolsetWithBot {
  name: string;
  enabled: boolean;
  configured: boolean;
  botId: string;
  botName?: string;
}

export function ToolsScreen({ route, navigation }: Props<'Tools'>) {
  const { profile } = route.params;
  const { bots, connection } = useWorkspace();
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);

  const load = useCallback(async (signal: AbortSignal): Promise<ToolsetWithBot[]> => {
    if (selectedBotId !== null) {
      const api = workspaceApi(connection, selectedBotId);
      const bot = bots.find(b => b.id === selectedBotId);
      const data = await api.workspace<{ name: string; enabled: boolean; configured: boolean }[]>('toolsets', 'GET', undefined, undefined, signal);
      return (data || []).map(t => ({ ...t, botId: selectedBotId, botName: bot?.name || selectedBotId }));
    }
    const results = await Promise.allSettled(
      bots.map(async bot => {
        const api = workspaceApi(connection, bot.id);
        const data = await api.workspace<{ name: string; enabled: boolean; configured: boolean }[]>('toolsets', 'GET', undefined, undefined, signal);
        return (data || []).map(t => ({ ...t, botId: bot.id, botName: bot.name }));
      })
    );
    return results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
  }, [selectedBotId, connection, bots]);

  const state = useResource(load);

  return (
    <Page
      title="Tools"
      {...state}
      onRefresh={state.refresh}
      header={<WorkspaceHeader canGoBack onGoBack={() => navigation.goBack()} title="Tools" />}
    >
      <BotFilterChips selectedBotId={selectedBotId} onSelectBot={setSelectedBotId} includeAll={true} />
      {state.data?.map(tool => (
        <Card
          key={`${tool.botId}:${tool.name}`}
          title={tool.name}
          subtitle={`${tool.botName ? `${tool.botName} · ` : ''}${tool.enabled ? 'Enabled' : 'Disabled'} · ${tool.configured ? 'Configured' : 'Setup required'}`}
        />
      ))}
      {state.data?.length === 0 && <Notice>No tools available for selected bots.</Notice>}
    </Page>
  );
}

export function BrowserScreen({ route, navigation }: Props<'Browser'>) {
  const { profile } = route.params, api = useBotApi(profile), [url, setUrl] = useState(''), [error, setError] = useState('');
  const load = useCallback((signal: AbortSignal) => api.request<{ state: string; url: string; tabs: { id: string; title: string; url: string }[] }>(`/api/hermes/browser/tabs?${new URLSearchParams({ profile })}`, 'GET', undefined, signal), [api, profile]);
  const state = useResource(load, 10000);
  return (
    <Page
      title="Browser"
      {...state}
      error={error || state.error}
      onRefresh={state.refresh}
      header={<WorkspaceHeader canGoBack onGoBack={() => navigation.goBack()} title="Browser" />}
    >
      <Field label="Website URL" value={url} onChangeText={setUrl} autoCapitalize="none" keyboardType="url" placeholder="https://example.com" />
      <Button
        label="Ask bot to browse"
        disabled={!url.trim()}
        onPress={() => {
          try {
            const parsed = new URL(url);
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
              throw new Error('Enter an HTTP or HTTPS URL without embedded credentials.');
            }
            navigation.push('Chat', { profile, draft: `Use your browser tools to open ${parsed.href} and summarize what you find. Ask me for any required approval.` });
          } catch (err) {
            setError(messageOf(err));
          }
        }}
      />
      <Notice>Review the request in chat and send it to your bot. Its browser runs on your instance.</Notice>
      {state.data && <Notice>Browser {state.data.state}</Notice>}
      {state.data?.tabs.map(tab => <Card key={tab.id} title={tab.title || tab.url || 'New tab'} subtitle={tab.url} />)}
    </Page>
  );
}

export function SettingsScreen({ route, navigation }: Props<'Settings'>) {
  const { profile } = route.params, p = usePalette();
  const items = [
    { name: 'Model' as const, icon: 'Bot' as const, label: 'Model' },
    { name: 'Appearance' as const, icon: 'Interests' as const, label: 'Appearance' },
    { name: 'Identity' as const, icon: 'Identity' as const, label: 'Identity' },
    { name: 'Skills' as const, icon: 'Skills' as const, label: 'Skills' },
    { name: 'Memory' as const, icon: 'Memory' as const, label: 'Memory' },
    { name: 'Tools' as const, icon: 'Tools' as const, label: 'Tools' },
  ];
  return (
    <Page title="Settings" header={<WorkspaceHeader canGoBack onGoBack={() => navigation.goBack()} title="Settings" />}>
      <View style={{ backgroundColor: p.surface, borderWidth: 1, borderColor: p.hair, borderRadius: 22, paddingHorizontal: 15, marginBottom: 16 }}>
        {items.map((item, index) => (
          <Pressable key={item.name} accessibilityRole="button" onPress={() => navigation.push(item.name, { profile })} style={[ui.row, { minHeight: 68, paddingHorizontal: 5, borderBottomWidth: index < items.length - 1 ? 0.5 : 0, borderColor: p.hair }]}>
            <Icon name={item.icon} color={p.ink} size={23} />
            <Text style={{ flex: 1, color: p.ink, fontSize: 17 }}>{item.label}</Text>
            <Icon name="Next" color={p.muted} size={19} />
          </Pressable>
        ))}
      </View>
      <View style={{ backgroundColor: p.surface, borderWidth: 1, borderColor: p.hair, borderRadius: 22, paddingHorizontal: 15 }}>
        <Pressable accessibilityRole="button" onPress={() => navigation.push('Connection')} style={[ui.row, { minHeight: 68, paddingHorizontal: 5 }]}>
          <Icon name="Connection" color={p.ink} size={23} />
          <Text style={{ flex: 1, color: p.ink, fontSize: 17 }}>Connection and notifications</Text>
          <Icon name="Next" color={p.muted} size={19} />
        </Pressable>
      </View>
    </Page>
  );
}

export function AppearanceScreen({ navigation }: Props<'Appearance'>) {
  const p = usePalette(), { mode, setMode } = useAppearance();
  return (
    <Page title="Appearance" header={<WorkspaceHeader canGoBack onGoBack={() => navigation.goBack()} title="Appearance" />}>
      <View style={{ backgroundColor: p.surface, borderWidth: 1, borderColor: p.hair, borderRadius: 22, paddingHorizontal: 15 }}>
        {(['dark', 'light', 'system'] as const).map((value, index) => (
          <Pressable key={value} accessibilityRole="radio" accessibilityState={{ selected: mode === value }} onPress={() => setMode(value)} style={[ui.row, { minHeight: 64, borderBottomWidth: index < 2 ? 0.5 : 0, borderColor: p.hair }]}>
            <Text style={{ flex: 1, color: p.ink, fontSize: 17 }}>{value === 'system' ? 'Use device theme' : value === 'dark' ? 'Dark' : 'Light'}</Text>
            {mode === value && <Icon name="Check" color={p.accent} size={22} />}
          </Pressable>
        ))}
      </View>
    </Page>
  );
}

export function ModelScreen({ route, navigation }: Props<'Model'>) {
  const { profile } = route.params;
  const { bots } = useWorkspace();
  const [selectedBotId, setSelectedBotId] = useState<string | null>(profile);
  const activeProfile = selectedBotId || profile;
  const api = useBotApi(activeProfile);
  const bot = bots.find(item => item.id === activeProfile);
  const load = useCallback((signal: AbortSignal) => api.request<{ model?: string; provider?: string }>(`/api/hermes/model?${new URLSearchParams({ profile: activeProfile })}`, 'GET', undefined, signal), [api, activeProfile]);
  const state = useResource(load), write = useWrite(), [model, setModel] = useState(''), [provider, setProvider] = useState(''), [saved, setSaved] = useState('');
  const save = (confirm = false) => void write.act(async () => {
    const result = await api.request<{ ok?: boolean; confirm_required?: boolean; confirm_message?: string }>(`/api/hermes/model?${new URLSearchParams({ profile: activeProfile })}`, 'POST', { scope: 'main', model: model.trim(), provider: provider.trim(), ...(confirm ? { confirm_expensive_model: true } : {}) });
    if (result.confirm_required && result.confirm_message) { Alert.alert('Confirm model change', result.confirm_message, [{ text: 'Cancel', style: 'cancel' }, { text: 'Confirm', onPress: () => save(true) }]); return; }
    if (result.ok !== true) throw new Error('The bot did not confirm this model change. Refresh before retrying.');
    setSaved('Model saved.'); await state.refresh();
  });
  return (
    <Page title="Model" {...state} error={write.error || state.error} header={<WorkspaceHeader canGoBack onGoBack={() => navigation.goBack()} title="Model" />}>
      <BotFilterChips selectedBotId={selectedBotId} onSelectBot={id => setSelectedBotId(id || profile)} includeAll={false} />
      <Card title={bot?.name || activeProfile} subtitle={bot?.roleDescription || 'Bot settings'} />
      <Notice>Current model: {state.data?.model || bot?.model || 'Not available'}</Notice>
      <Field label="Model" value={model} onChangeText={value => { setModel(value); setSaved(''); }} autoCapitalize="none" placeholder="provider/model" editable={!write.busy} />
      <Field label="Provider (optional)" value={provider} onChangeText={setProvider} autoCapitalize="none" editable={!write.busy} />
      <Button label="Save model" disabled={write.busy || !model.trim()} onPress={() => save()} />
      {Boolean(saved) && <Notice>{saved}</Notice>}
    </Page>
  );
}

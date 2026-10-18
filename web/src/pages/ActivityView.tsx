import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronRight, Inbox, RefreshCw } from 'lucide-react';
import { apiFetch } from '../services/api';
import { useChat } from '../context/ChatContext';
import { useRuntime } from '../context/RuntimeContext';
import { DogeshAvatar } from '../components/DogeshAvatar';
import { buttonClass, CardList, CardRow, EmptyState, Notice, sectionLabelClass, Skeleton, StatusPill } from '../components/WorkspaceUI';
import { errorText } from '../components/workspaceUtils';
import type { TaskItem } from '../types/chat';

interface ActivityEntry extends TaskItem {
  botId: string;
  botName: string;
  avatarUrl?: string;
}

type StatusFilter = 'all' | 'running' | 'attention' | 'done';

const isPreview = () =>
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('preview') === '1';

const dayLabel = (date: Date) => {
  const now = new Date();
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const diff = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
};

const timeLabel = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

const entryKey = (entry: ActivityEntry) => `${entry.botId}:${entry.id}`;
const needsAttention = (status: TaskItem['status']) => status === 'failed' || status === 'interrupted';

const matchStatus = (status: TaskItem['status'], filter: StatusFilter) => {
  if (filter === 'all') return true;
  if (filter === 'running') return status === 'in_progress' || status === 'pending';
  if (filter === 'attention') return needsAttention(status);
  if (filter === 'done') return status === 'completed';
  return true;
};

const statusFilters: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'done', label: 'Done' },
];

export function ActivityView() {
  const { agents, agent, selectAgent, activityFilter, setActivityFilter } = useChat();
  const runtime = useRuntime();

  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [lastUpdated, setLastUpdated] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // The context replaces the roster array on every refresh. Use a stable key so
  // the poll timer only restarts when the set of bots actually changes, while a
  // ref always sees the latest roster without churning the polling callback.
  const rosterKey = useMemo(() => agents.map((bot) => bot.id).join('|'), [agents]);
  const agentsRef = useRef(agents);
  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 20000);
    return () => window.clearInterval(timer);
  }, []);

  const load = useCallback(async () => {
    const roster = agentsRef.current;
    if (isPreview()) {
      const samples = [
        { title: 'Searched the web', ago: 4, status: 'completed' as const, subtitle: 'Latest headlines' },
        { title: 'Executed a script', ago: 26, status: 'in_progress' as const, subtitle: 'Working…' },
        { title: 'Updated memory', ago: 90, status: 'completed' as const, subtitle: 'Saved notes' },
        { title: 'Reviewed a document', ago: 60 * 26, status: 'failed' as const, subtitle: 'Report.pdf' },
        { title: 'Scheduled a task', ago: 60 * 30, status: 'completed' as const, subtitle: 'Daily digest' },
      ];
      const bots = roster.length ? roster : [{ id: agent?.id || 'main', name: agent?.name || 'Main' }];
      setEntries(
        samples.map((sample, index) => {
          const bot = bots[index % bots.length];
          return {
            id: `preview-${index}`,
            title: sample.title,
            subtitle: sample.subtitle,
            timestamp: new Date(Date.now() - sample.ago * 60000).toISOString(),
            status: sample.status,
            botId: bot.id,
            botName: bot.name,
            avatarUrl: bot.avatarUrl,
          };
        })
      );
      setError('');
      setLoading(false);
      setLastUpdated(Date.now());
      return;
    }
    if (roster.length === 0) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      let collected: ActivityEntry[] = [];
      if (runtime === 'hermes') {
        const results = await Promise.allSettled(
          roster.map(async (bot) => {
            const items = await apiFetch<TaskItem[]>('/api/tasks', { headers: { 'X-Hob-Profile': bot.id } });
            return items.map((item) => ({ ...item, botId: bot.id, botName: bot.name, avatarUrl: bot.avatarUrl }));
          })
        );
        collected = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
        const failure = results.find((result) => result.status === 'rejected');
        if (collected.length === 0 && failure?.status === 'rejected') throw failure.reason;
      } else {
        const items = await apiFetch<TaskItem[]>('/api/tasks');
        collected = items.map((item) => {
          const bot = roster.find((candidate) => candidate.id === item.agentId) || roster.find((candidate) => candidate.id === agent?.id);
          return {
            ...item,
            botId: bot?.id || item.agentId || agent?.id || 'main',
            botName: bot?.name || agent?.name || 'Main',
            avatarUrl: bot?.avatarUrl,
          };
        });
      }
      collected.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
      setEntries(collected);
      setError('');
      setLastUpdated(Date.now());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [runtime, agent?.id, agent?.name]);

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    const tick = () => void loadRef.current();
    const initial = window.setTimeout(tick, 0);
    const poll = window.setInterval(tick, 8000);
    const onFocus = () => tick();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(poll);
      window.removeEventListener('focus', onFocus);
    };
  }, [rosterKey, runtime, agent?.id]);

  const visible = useMemo(
    () =>
      entries.filter(
        (entry) => (!activityFilter || entry.botId === activityFilter) && matchStatus(entry.status, statusFilter)
      ),
    [entries, activityFilter, statusFilter]
  );

  const filterBot = activityFilter ? agents.find((bot) => bot.id === activityFilter) : undefined;

  // When showing everything, pin the failures that likely need a human first,
  // and keep them out of the date groups so nothing appears twice.
  const attention = useMemo(() => (statusFilter === 'all' ? visible.filter((entry) => needsAttention(entry.status)) : []), [visible, statusFilter]);
  const attentionKeys = useMemo(() => new Set(attention.map(entryKey)), [attention]);

  const groups = useMemo(() => {
    const map = new Map<string, ActivityEntry[]>();
    for (const entry of visible) {
      if (attentionKeys.has(entryKey(entry))) continue;
      const date = new Date(entry.timestamp);
      const key = Number.isNaN(date.getTime()) ? 'Earlier' : dayLabel(date);
      const bucket = map.get(key);
      if (bucket) bucket.push(entry);
      else map.set(key, [entry]);
    }
    return [...map.entries()];
  }, [visible, attentionKeys]);

  const openBot = (entry: ActivityEntry) => {
    void selectAgent(entry.botId).catch(() => undefined);
  };

  const updatedLabel = lastUpdated
    ? now - lastUpdated < 60000
      ? 'Updated just now'
      : `Updated ${Math.round((now - lastUpdated) / 60000)}m ago`
    : '';

  const renderRow = (entry: ActivityEntry) => (
    <CardRow key={entryKey(entry)} onClick={() => openBot(entry)} className="items-start group">
      <DogeshAvatar size={30} avatarUrl={entry.avatarUrl} showEditBadge={false} hideStatusDot />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-semibold text-ink truncate">{entry.title}</span>
          <StatusPill status={entry.status} />
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 text-[12px] text-faint min-w-0">
          <span className="font-medium text-muted truncate">{entry.botName}</span>
          {entry.subtitle && <span className="truncate">· {entry.subtitle}</span>}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0 pt-0.5 text-[12px] text-faint">
        {timeLabel(entry.timestamp)}
        <ChevronRight size={14} className="opacity-0 group-hover:opacity-100 transition-opacity text-accent" />
      </div>
    </CardRow>
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <p className="text-xs md:text-sm text-muted truncate">
            {filterBot ? `Showing activity for ${filterBot.name}` : 'Every bot, one live timeline.'}
          </p>
          {updatedLabel && <span className="hidden md:inline text-[11px] text-faint shrink-0">{updatedLabel}</span>}
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] font-medium text-ok">
            <span className="w-1.5 h-1.5 rounded-full bg-ok-dot animate-pulse" />
            Live
          </span>
          <button
            type="button"
            title="Refresh activity"
            aria-label="Refresh activity"
            className={buttonClass}
            onClick={() => void load()}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {/* Bot filter chips */}
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        <button
          type="button"
          onClick={() => setActivityFilter(null)}
          className={`shrink-0 inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12.5px] font-medium border transition-colors cursor-pointer ${
            activityFilter === null
              ? 'border-accent bg-accent-soft text-accent'
              : 'border-edge bg-surface text-soft hover:border-edge-strong'
          }`}
        >
          All bots
        </button>
        {agents.map((bot) => {
          const active = activityFilter === bot.id;
          return (
            <button
              key={bot.id}
              type="button"
              onClick={() => setActivityFilter(active ? null : bot.id)}
              className={`shrink-0 inline-flex items-center gap-2 rounded-full pl-1 pr-3.5 py-1 text-[12.5px] font-medium border transition-colors cursor-pointer ${
                active
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-edge bg-surface text-soft hover:border-edge-strong'
              }`}
            >
              <DogeshAvatar size={22} avatarUrl={bot.avatarUrl} showEditBadge={false} hideStatusDot />
              <span className="max-w-[120px] truncate">{bot.name}</span>
            </button>
          );
        })}
      </div>

      {/* Status filter chips */}
      <div className="flex gap-2 overflow-x-auto -mx-1 px-1">
        {statusFilters.map((filter) => (
          <button
            key={filter.id}
            type="button"
            onClick={() => setStatusFilter(filter.id)}
            className={`shrink-0 rounded-lg px-3 py-1 text-[12px] font-medium border transition-colors cursor-pointer ${
              statusFilter === filter.id
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-transparent text-muted hover:bg-hover hover:text-ink'
            }`}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {error && <Notice error>{error}</Notice>}

      {loading && entries.length === 0 ? (
        <CardList>
          {[0, 1, 2, 3, 4].map((index) => (
            <div key={index} className="flex items-start gap-3 px-3 py-3 border-b border-line last:border-b-0">
              <Skeleton className="h-[30px] w-[30px] rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-1/3" />
                <Skeleton className="h-3 w-1/4" />
              </div>
            </div>
          ))}
        </CardList>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Inbox size={28} />}
          title={filterBot ? `No activity for ${filterBot.name}` : statusFilter === 'all' ? 'No bot activity yet' : 'Nothing here right now'}
          description={
            filterBot
              ? 'This bot has not recorded anything in the current view.'
              : statusFilter === 'all'
                ? 'It will appear here as your bots work.'
                : 'Try a different filter or check back once a bot runs.'
          }
        />
      ) : (
        <div className="space-y-5">
          {attention.length > 0 && (
            <div className="space-y-1.5">
              <h4 className="inline-flex items-center gap-1.5 px-1 text-[12px] font-medium text-warn">
                <AlertTriangle size={12} /> Needs attention
              </h4>
              <CardList>{attention.map(renderRow)}</CardList>
            </div>
          )}
          {groups.map(([label, items]) => (
            <div key={label} className="space-y-1.5">
              <h4 className={sectionLabelClass}>{label}</h4>
              <CardList>{items.map(renderRow)}</CardList>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

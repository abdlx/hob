import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { apiFetch } from '../services/api';
import { useChat } from '../context/ChatContext';
import { useRuntime } from '../context/RuntimeContext';
import { DogeshAvatar } from '../components/DogeshAvatar';
import { buttonClass, Notice } from '../components/WorkspaceUI';
import { errorText } from '../components/workspaceUtils';
import type { TaskItem } from '../types/chat';

interface ActivityEntry extends TaskItem {
  botId: string;
  botName: string;
  avatarUrl?: string;
}

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

const statusStyle = (status: TaskItem['status']) => {
  switch (status) {
    case 'in_progress':
      return { label: 'Running', className: 'bg-[#FFF3D6] text-[#9A6400]', dot: 'bg-amber-400' };
    case 'completed':
      return { label: 'Done', className: 'bg-[#DDF6EC] text-[#0B7A52]', dot: 'bg-[#16CC8A]' };
    case 'failed':
    case 'cancelled':
      return { label: status === 'failed' ? 'Failed' : 'Cancelled', className: 'bg-[#FDE3E3] text-[#B42318]', dot: 'bg-red-500' };
    case 'interrupted':
      return { label: 'Interrupted', className: 'bg-[#FDE9DF] text-[#B54708]', dot: 'bg-orange-500' };
    case 'pending':
      return { label: 'Queued', className: 'bg-[#EEF1F4] text-[#51606F]', dot: 'bg-[#8792A1]' };
    default:
      return { label: 'Unknown', className: 'bg-[#EEF1F4] text-[#51606F]', dot: 'bg-[#8792A1]' };
  }
};

function StatusPill({ status }: { status: TaskItem['status'] }) {
  const style = statusStyle(status);
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${style.className}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
      {style.label}
    </span>
  );
}

export function ActivityView() {
  const { agents, agent, activityFilter, setActivityFilter } = useChat();
  const runtime = useRuntime();

  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // The context replaces the roster array on every refresh. Use a stable key so
  // the poll timer only restarts when the set of bots actually changes, while a
  // ref always sees the latest roster without churning the polling callback.
  const rosterKey = useMemo(() => agents.map((bot) => bot.id).join('|'), [agents]);
  const agentsRef = useRef(agents);
  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  const load = useCallback(async () => {
    const roster = agentsRef.current;
    if (isPreview()) {
      const samples = [
        { title: 'Searched the web', ago: 4, status: 'completed' as const, subtitle: 'Latest headlines' },
        { title: 'Executed a script', ago: 26, status: 'in_progress' as const, subtitle: 'Working…' },
        { title: 'Updated memory', ago: 90, status: 'completed' as const, subtitle: 'Saved notes' },
        { title: 'Reviewed a document', ago: 60 * 26, status: 'completed' as const, subtitle: 'Report.pdf' },
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
    () => (activityFilter ? entries.filter((entry) => entry.botId === activityFilter) : entries),
    [entries, activityFilter]
  );

  const groups = useMemo(() => {
    const map = new Map<string, ActivityEntry[]>();
    for (const entry of visible) {
      const date = new Date(entry.timestamp);
      const key = Number.isNaN(date.getTime()) ? 'Earlier' : dayLabel(date);
      const bucket = map.get(key);
      if (bucket) bucket.push(entry);
      else map.set(key, [entry]);
    }
    return [...map.entries()];
  }, [visible]);

  const filterBot = activityFilter ? agents.find((bot) => bot.id === activityFilter) : undefined;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs md:text-sm text-[#687588]">
          {filterBot ? `Showing activity for ${filterBot.name}` : 'Every bot, one live timeline.'}
        </p>
        <div className="flex items-center gap-2.5 shrink-0">
          <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] font-medium text-[#0B7A52]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#16CC8A] animate-pulse" />
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
              ? 'border-[#1677FF] bg-[#E4EEFF] text-[#1677FF]'
              : 'border-[rgba(25,35,50,0.1)] bg-white text-[#51606F] hover:border-[rgba(25,35,50,0.2)]'
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
                  ? 'border-[#1677FF] bg-[#E4EEFF] text-[#1677FF]'
                  : 'border-[rgba(25,35,50,0.1)] bg-white text-[#51606F] hover:border-[rgba(25,35,50,0.2)]'
              }`}
            >
              <DogeshAvatar size={22} avatarUrl={bot.avatarUrl} showEditBadge={false} hideStatusDot />
              <span className="max-w-[120px] truncate">{bot.name}</span>
            </button>
          );
        })}
      </div>

      {error && <Notice error>{error}</Notice>}

      {loading && entries.length === 0 ? (
        <Notice>Loading activity…</Notice>
      ) : visible.length === 0 ? (
        <Notice>
          {filterBot ? `No activity for ${filterBot.name} yet.` : 'No bot activity yet. It will appear here as your bots work.'}
        </Notice>
      ) : (
        <div className="space-y-5">
          {groups.map(([label, items]) => (
            <div key={label} className="space-y-1.5">
              <h4 className="text-[12px] font-medium text-[#687588] px-1">{label}</h4>
              <div className="rounded-2xl border border-[rgba(25,35,50,0.06)] bg-white overflow-hidden">
                {items.map((entry) => (
                  <div
                    key={`${entry.botId}:${entry.id}`}
                    className="flex items-start gap-3 px-3 py-2.5 border-b border-[rgba(25,35,50,0.05)] last:border-b-0 hover:bg-black/[0.02] transition-colors"
                  >
                    <DogeshAvatar size={30} avatarUrl={entry.avatarUrl} showEditBadge={false} hideStatusDot />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[13px] font-semibold text-[#17191D] truncate">{entry.title}</span>
                        <StatusPill status={entry.status} />
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5 text-[12px] text-[#8792A1] min-w-0">
                        <span className="font-medium text-[#687588] truncate">{entry.botName}</span>
                        {entry.subtitle && <span className="truncate">· {entry.subtitle}</span>}
                      </div>
                    </div>
                    <span className="text-[12px] text-[#8792A1] shrink-0 pt-0.5">{timeLabel(entry.timestamp)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

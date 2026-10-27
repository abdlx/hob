import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  Plus,
  Search,
  Settings,
  Sparkles,
  Trash2,
  Pencil,
  Users,
  X,
} from 'lucide-react';
import { useToast } from '../context/ToastContext';
import { useChat } from '../context/ChatContext';
import { useRuntime } from '../context/RuntimeContext';
import { DogeshAvatar } from './DogeshAvatar';
import { apiFetch } from '../services/api';
import { requestId } from '../services/id';
import { chatPreview } from '../services/chat-preview';
import { buttonClass } from './WorkspaceUI';
import type { GroupSummary } from '../types/chat';

interface BotsSidebarProps {
  onSelectBot?: (botId: string) => void;
  collapsed?: boolean;
}

const groupApi = <T,>(route = '', init: RequestInit = {}) =>
  apiFetch<T>(`/api/hermes/groups${route}`, { ...init, headers: { 'X-Hob-Profile': 'default', ...(init.headers || {}) } });
const post = (value: unknown) => ({ method: 'POST', body: JSON.stringify(value) });
const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

export const BotsSidebar: React.FC<BotsSidebarProps> = ({ onSelectBot, collapsed = false }) => {
  const {
    agents,
    agent,
    selectAgent,
    connected,
    isPreparing,
    setActiveNav,
    refresh,
    activeNav,
    activityFilter,
    setActivityFilter,
    setBotsSidebarOpen,
    groups,
    loadGroups,
    selectedGroupId,
    setSelectedGroupId,
  } = useChat();
  const runtime = useRuntime();
  const { toast } = useToast();

  const [search, setSearch] = useState('');
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newBotName, setNewBotName] = useState('');
  const [newBotDisplayName, setNewBotDisplayName] = useState('');
  const [newBotSoul, setNewBotSoul] = useState('');
  const [newBotTags, setNewBotTags] = useState('');
  const [newBotRole, setNewBotRole] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string; tags?: string[]; roleDescription?: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameTags, setRenameTags] = useState('');
  const [renameRole, setRenameRole] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);

  // Bot groups are managed here, beside the bots they collect.
  const [isGroupFormOpen, setIsGroupFormOpen] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupMembers, setGroupMembers] = useState<string[]>([]);
  const [groupError, setGroupError] = useState('');
  const [isGroupBusy, setIsGroupBusy] = useState(false);
  const [disbandTarget, setDisbandTarget] = useState<GroupSummary | null>(null);
  const groupRequest = useRef<string | null>(null);

  const manageGroups = runtime === 'hermes' && !collapsed;
  useEffect(() => {
    if (!manageGroups) return;
    const report = (error: unknown) => setGroupError(message(error, 'Failed to load groups.'));
    void loadGroups().catch(report);
    const timer = window.setInterval(() => { void loadGroups().catch(() => {}); }, 15000);
    return () => window.clearInterval(timer);
  }, [manageGroups, loadGroups]);

  // Filter bots by search query
  const filteredAgents = useMemo(() => {
    if (!search.trim()) return agents;
    const q = search.toLowerCase();
    return agents.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        b.id.toLowerCase().includes(q) ||
        (b.model && b.model.toLowerCase().includes(q)) ||
        (b.roleDescription && b.roleDescription.toLowerCase().includes(q)) ||
        b.tags?.some(tag => tag.toLowerCase().includes(q))
    );
  }, [agents, search]);

  const handleCreateBot = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = newBotName.trim().toLowerCase();
    if (!cleanName) return;

    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(cleanName)) {
      setCreateError('Name must start with a letter and contain only lowercase letters, digits, dashes, or underscores.');
      return;
    }

    setIsSubmitting(true);
    setCreateError(null);
    try {
      let selectedName = cleanName;
      if (runtime === 'hermes') {
        const label = newBotDisplayName.trim();
        const created = await apiFetch<{ name?: string; sync?: { failed: { name: string; error: string }[] } }>('/api/hermes/profiles', {
          method: 'POST',
          body: JSON.stringify({ name: cleanName, ...(label ? { displayName: label } : {}), soul: newBotSoul.trim(), tags: newBotTags.split(',').map(tag => tag.trim()).filter(Boolean), description: newBotRole.trim() }),
        });
        // A deleted profile id is retired, so the server may have allocated a
        // suffixed internal id (for example `coder-2`). Select that identity.
        if (created?.name) selectedName = created.name;
        if (created.sync?.failed.length) toast('Bot created. Identity synchronization needs a retry: ' + created.sync.failed.map(item => item.name + ': ' + item.error).join('; '), 'error');
      } else {
        await apiFetch('/api/agents', {
          method: 'POST',
          body: JSON.stringify({ name: cleanName }),
        });
      }
      await refresh();
      await selectAgent(selectedName);
      setNewBotName('');
      setNewBotDisplayName('');
      setNewBotSoul('');
      setNewBotTags(''); setNewBotRole('');
      setIsCreateOpen(false);
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create bot.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteBot = async () => {
    if (!deleteTarget || deleteTarget === 'default' || runtime !== 'hermes') return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const deletingCurrent = agent?.id === deleteTarget;
      await apiFetch(`/api/hermes/profiles/${encodeURIComponent(deleteTarget)}`, { method: 'DELETE' });
      setDeleteTarget(null);
      if (deletingCurrent) await selectAgent('default');
      else await refresh();
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete bot.');
    } finally {
      setIsDeleting(false);
    }
  };

  const openRename = (bot: { id: string; name: string; tags?: string[]; roleDescription?: string }) => {
    setRenameTarget(bot);
    setRenameValue(bot.name);
    setRenameTags((bot.tags || []).join(', '));
    setRenameRole(bot.roleDescription || '');
    setRenameError(null);
  };

  const handleRenameBot = async (event: React.FormEvent) => {
    event.preventDefault();
    const label = renameValue.trim();
    if (!renameTarget || runtime !== 'hermes' || !label || isRenaming) return;
    setIsRenaming(true);
    setRenameError(null);
    try {
      const result = await apiFetch<{ sync?: { failed: { name: string; error: string }[] } }>(`/api/hermes/profiles/${encodeURIComponent(renameTarget.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ displayName: label, tags: renameTags.split(',').map(tag => tag.trim()).filter(Boolean), description: renameRole.trim() }),
      });
      await refresh();
      if (result.sync?.failed.length) throw new Error('Identity saved, but synchronization needs a retry: ' + result.sync.failed.map(item => item.name + ': ' + item.error).join('; '));
      setRenameTarget(null);
    } catch (err: unknown) {
      setRenameError(err instanceof Error ? err.message : 'Failed to rename bot.');
    } finally {
      setIsRenaming(false);
    }
  };

  const toggleGroupMember = (id: string) => {
    groupRequest.current = null;
    setGroupMembers((previous) => previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous, id]);
  };

  const createGroup = async () => {
    const name = groupName.trim();
    if (!name || groupMembers.length < 2 || isGroupBusy) return;
    setIsGroupBusy(true); setGroupError('');
    groupRequest.current ??= requestId();
    try {
      const result = await groupApi<{ group: GroupSummary }>('', post({ requestId: groupRequest.current, name, members: groupMembers, confirm: true }));
      setSelectedGroupId(result.group.id);
      setActiveNav('groups');
      setGroupName(''); setGroupMembers([]); setIsGroupFormOpen(false); groupRequest.current = null;
      await loadGroups();
    } catch (err) { setGroupError(message(err, 'Failed to create group.')); }
    finally { setIsGroupBusy(false); }
  };

  const disbandGroup = async (id: string) => {
    setIsGroupBusy(true); setGroupError('');
    try {
      await groupApi(`/${encodeURIComponent(id)}/disband`, post({ confirm: true }));
      setDisbandTarget(null);
      if (selectedGroupId === id) setSelectedGroupId('');
      await loadGroups();
    } catch (err) { setGroupError(message(err, 'Failed to disband group.')); }
    finally { setIsGroupBusy(false); }
  };

  if (collapsed) {
    return (
      <div
        className="hob-bots-rail flex-1 min-w-0 min-h-0 h-full flex flex-col items-center gap-2 py-4 overflow-y-auto bg-canvas select-none"
        aria-label="Bots"
      >
        <button
          type="button"
          onClick={() => setBotsSidebarOpen(true)}
          title="Show bots"
          aria-label="Show bots"
          className="w-9 h-9 rounded-full flex items-center justify-center text-code hover:bg-neutral transition-colors cursor-pointer shrink-0"
        >
          <ChevronRight size={18} strokeWidth={2} />
        </button>
        {agents.map((bot) => {
          const isCurrent = bot.id === (agent?.id || '');
          return (
            <button
              key={bot.id}
              type="button"
              onClick={() => { void selectAgent(bot.id); if (onSelectBot) onSelectBot(bot.id); }}
              title={bot.name}
              aria-label={bot.name}
              aria-current={isCurrent ? 'true' : undefined}
              className={`shrink-0 rounded-full transition-transform cursor-pointer ${isCurrent ? 'ring-2 ring-accent ring-offset-2 ring-offset-canvas' : 'opacity-80 hover:opacity-100'}`}
            >
              <DogeshAvatar size={40} showEditBadge={false} avatarUrl={bot.avatarUrl || '/brand/hob-mark.png'} hideBorder hideStatusDot />
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <>
      <div
        className="hob-bots-sidebar flex-1 min-w-0 min-h-0 h-full flex flex-col bg-canvas select-none"
        aria-label="Bots directory"
      >
        {/* Header: Bots, badge, + button */}
        <div className="px-5 pt-6 pb-2.5 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[17px] font-semibold text-ink tracking-tight">Bots</h2>
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-neutral text-muted">
              {agents.length}
            </span>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setBotsSidebarOpen(false)}
              title="Hide bots"
              aria-label="Hide bots"
              className="w-8 h-8 rounded-full hidden md:flex items-center justify-center text-code hover:bg-neutral transition-colors cursor-pointer"
            >
              <ChevronRight size={16} strokeWidth={2} className="rotate-180" />
            </button>
            <button
              type="button"
              onClick={() => setIsCreateOpen(true)}
              title="Create new bot"
              aria-label="Create new bot"
              className="w-8 h-8 rounded-full flex items-center justify-center text-code hover:bg-neutral transition-colors cursor-pointer"
            >
              <Plus size={18} strokeWidth={2} />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="px-4 py-2 shrink-0">
          <div className="relative flex items-center">
            <Search
              size={15}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none"
            />
            <input
              type="text"
              placeholder="Search bots..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-10 bg-neutral text-[13px] text-ink pl-9 pr-12 rounded-full border border-transparent focus:outline-none placeholder-faint transition-all"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-faint hover:text-ink p-1 cursor-pointer"
              >
                <X size={13} />
              </button>
            ) : (
              <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[11px] font-medium text-faint pointer-events-none select-none">
                ⌘ K
              </span>
            )}
          </div>
        </div>

        {/* Groups: created and managed beside the bots they collect */}
        {manageGroups && (
          <div className="px-3 pb-2 shrink-0">
            <div className="flex items-center justify-between px-2 pt-1 pb-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">Groups</span>
              <button
                type="button"
                onClick={() => { setGroupError(''); setIsGroupFormOpen((open) => !open); }}
                title="New group"
                aria-label="New group"
                aria-expanded={isGroupFormOpen}
                className="w-7 h-7 rounded-full flex items-center justify-center text-code hover:bg-neutral transition-colors cursor-pointer"
              >
                <Plus size={15} strokeWidth={2} />
              </button>
            </div>
            {groupError && <p className="px-2 pb-1 text-[11px] leading-snug text-red-600" role="alert">{groupError}</p>}
            {isGroupFormOpen && (
              <div className="mb-1 rounded-2xl border border-hair bg-panel p-3 space-y-2">
                <input
                  type="text"
                  placeholder="Group name"
                  value={groupName}
                  disabled={isGroupBusy}
                  onChange={(event) => { groupRequest.current = null; setGroupName(event.target.value); }}
                  className="w-full bg-surface text-[13px] text-ink px-3 py-2 rounded-xl border border-edge focus:outline-none focus:border-accent placeholder-faint"
                />
                <fieldset className="space-y-1">
                  <legend className="text-[11px] text-muted mb-1">Choose two to six bots</legend>
                  <div className="max-h-40 overflow-y-auto space-y-1">
                    {agents.map((item) => (
                      <label key={item.id} className="flex items-center gap-2 text-[12.5px] text-soft">
                        <input
                          type="checkbox"
                          checked={groupMembers.includes(item.id)}
                          disabled={isGroupBusy || (groupMembers.length >= 6 && !groupMembers.includes(item.id))}
                          onChange={() => toggleGroupMember(item.id)}
                        />
                        <span className="truncate">{item.name}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="flex gap-2">
                  <button type="button" className={buttonClass} disabled={isGroupBusy || !groupName.trim() || groupMembers.length < 2} onClick={() => void createGroup()}>
                    {isGroupBusy ? 'Creating…' : 'Create group'}
                  </button>
                  <button type="button" className={buttonClass} disabled={isGroupBusy} onClick={() => setIsGroupFormOpen(false)}>Cancel</button>
                </div>
              </div>
            )}
            {!isGroupFormOpen && groups.length === 0 && (
              <p className="px-2 pb-1 text-[11px] text-faint">No groups yet.</p>
            )}
            <div className="max-h-44 overflow-y-auto space-y-0.5">
              {groups.map((item) => {
                const isSelected = selectedGroupId === item.id && activeNav === 'groups';
                return (
                  <div
                    key={item.id}
                    role="listitem"
                    tabIndex={0}
                    onClick={() => { setSelectedGroupId(item.id); setActiveNav('groups'); }}
                    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { setSelectedGroupId(item.id); setActiveNav('groups'); } }}
                    className={`group relative flex items-center gap-2 px-2 py-1.5 rounded-[12px] cursor-pointer transition-colors ${isSelected ? 'bg-accent-soft text-code-strong' : 'text-ink hover:bg-neutral'}`}
                  >
                    <Users size={14} strokeWidth={1.8} className={isSelected ? 'text-accent' : 'text-muted'} />
                    <span className="flex-1 min-w-0 truncate text-[13px] font-medium">{item.name}</span>
                    {item.disbanded ? (
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-faint">disbanded</span>
                    ) : (
                      <button
                        type="button"
                        onClick={(event) => { event.stopPropagation(); setGroupError(''); setDisbandTarget(item); }}
                        title={`Disband ${item.name}`}
                        aria-label={`Disband ${item.name}`}
                        className="shrink-0 rounded-md p-1 text-faint opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 focus-visible:opacity-100 cursor-pointer"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Contacts / Bots List */}
        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-1 space-y-1" role="list">
          {filteredAgents.length === 0 ? (
            <div className="text-center py-8 px-4 text-faint">
              <p className="text-xs">No bots match "{search}".</p>
            </div>
          ) : (
            filteredAgents.map((bot) => {
              const isCurrent = bot.id === (agent?.id || '');
              const filteringActivity = activeNav === 'activity';
              const isSelected = filteringActivity ? activityFilter === bot.id : isCurrent;
              const avatar =
                bot.avatarUrl ||
                (isCurrent && agent?.avatarUrl ? agent.avatarUrl : '/brand/hob-mark.png');
              const botStatus = isCurrent
                ? connected
                  ? 'connected'
                  : isPreparing
                  ? 'busy'
                  : 'disconnected'
                : 'connected';

              const subtitle = isCurrent
                ? bot.identitySync === 'pending' ? 'Identity sync pending' : isPreparing
                  ? 'Preparing bot...'
                  : connected
                  ? 'Active now'
                  : 'Offline'
                : chatPreview(bot.lastMessageSnippet);

              const select = () => {
                if (filteringActivity) {
                  setActivityFilter(isSelected ? null : bot.id);
                  return;
                }
                void selectAgent(bot.id);
                if (onSelectBot) onSelectBot(bot.id);
              };

              return (
                <div
                  key={bot.id}
                  onClick={select}
                  role="listitem"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      select();
                    }
                  }}
                  className={`group relative flex items-center gap-3 p-2.5 h-[64px] rounded-[18px] cursor-pointer transition-all duration-150 ${
                    isSelected
                      ? 'bg-accent-soft text-code-strong'
                      : 'bg-transparent hover:bg-neutral text-ink'
                  }`}
                >
                  {/* Avatar with status indicator */}
                  <div className="relative shrink-0">
                    <DogeshAvatar
                      size={42}
                      showEditBadge={false}
                      avatarUrl={avatar}
                      status={botStatus}
                      ringColor={isSelected ? 'ring-accent-soft' : 'ring-canvas'}
                    />
                  </div>

                  {/* Info details */}
                  <div className="flex-1 min-w-0 pr-1">
                    <div className="flex items-center justify-between gap-1">
                      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                      <span
                        className={`max-w-full text-[14.5px] font-semibold truncate ${
                          isSelected ? 'text-code-strong' : 'text-ink'
                        }`}
                      >
                        {bot.name}
                      </span>
                      {bot.tags?.slice(0, 2).map(tag => <span key={tag} className="max-w-20 truncate rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent" title={tag}>{tag}</span>)}

                      </div>
                      <div className="shrink-0 flex items-center gap-1">
                        {!isCurrent && !isSelected && (
                          <span className="w-2 h-2 rounded-full bg-ok-dot opacity-70" />
                        )}
                        {runtime === 'hermes' && !filteringActivity && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              openRename(bot);
                            }}
                            className="rounded-md p-1 text-faint opacity-0 transition-opacity hover:bg-neutral hover:text-ink group-hover:opacity-100 focus-visible:opacity-100 cursor-pointer"
                            aria-label={`Rename ${bot.name}`}
                            title={`Rename ${bot.name}`}
                          >
                            <Pencil size={12} />
                          </button>
                        )}
                        {runtime === 'hermes' && bot.id !== 'default' && !filteringActivity && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setDeleteError(null);
                              setDeleteTarget(bot.id);
                            }}
                            className="rounded-md p-1 text-faint opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 focus-visible:opacity-100 cursor-pointer"
                            aria-label={`Delete ${bot.name}`}
                            title={`Delete ${bot.name}`}
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                    <p
                      className={`text-[12px] truncate mt-0.5 ${
                        isSelected ? 'text-muted' : 'text-faint'
                      }`}
                    >
                      {filteringActivity && isSelected ? 'Filtering activity' : subtitle}
                    </p>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer: + New Bot and Manage in Settings */}
        <div className="hidden md:block p-4 pt-2 border-t border-line bg-canvas space-y-2.5 shrink-0">
          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            className="w-full h-[46px] rounded-full bg-sunken hover:bg-neutral-strong text-ink text-[13.5px] font-semibold flex items-center justify-center gap-2 transition-all cursor-pointer active:scale-[0.98]"
          >
            <Plus size={16} strokeWidth={2.2} />
            <span>New Bot</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveNav('settings')}
            className="w-full flex items-center justify-center gap-1.5 py-1 text-muted hover:text-ink text-[12.5px] font-medium transition-colors cursor-pointer"
          >
            <Settings size={13} strokeWidth={1.8} />
            <span>Manage in Settings</span>
          </button>
        </div>
      </div>

      {/* Create Bot Modal Dialog */}
      {isCreateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-in fade-in duration-150">
          <div
            className="w-full max-w-md max-h-[90dvh] overflow-y-auto bg-surface border border-edge rounded-[26px] shadow-2xl p-6 space-y-4 animate-in zoom-in-95 duration-150"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <div className="flex items-center justify-between pb-3 border-b border-hair">
              <div className="flex items-center space-x-2.5">
                <div className="w-8 h-8 rounded-full bg-accent-soft flex items-center justify-center text-accent">
                  <Sparkles size={16} />
                </div>
                <div>
                  <h3 id="modal-title" className="text-base font-semibold text-ink">
                    Create New Bot
                  </h3>
                  <p className="text-xs text-muted">Add a contact with its own personality</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsCreateOpen(false)}
                className="p-1.5 rounded-full text-faint hover:text-ink hover:bg-neutral transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {createError && (
              <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs">
                {createError}
              </div>
            )}

            <form onSubmit={handleCreateBot} className="space-y-4">
              {runtime === 'hermes' && <>
                <label className="block text-xs font-medium text-ink">Labels (comma separated)<input aria-label="New bot labels" value={newBotTags} onChange={e => setNewBotTags(e.target.value)} className="mt-1 w-full rounded-xl border border-edge bg-panel p-3 text-sm" placeholder="Research, Coding" /></label>
                <label className="block text-xs font-medium text-ink">Role<textarea aria-label="New bot role" value={newBotRole} onChange={e => setNewBotRole(e.target.value)} maxLength={2000} className="mt-1 w-full rounded-xl border border-edge bg-panel p-3 text-sm" rows={2} /></label>
              </>}
              <div>
                <label className="block text-xs md:text-sm font-medium text-ink mb-1.5">
                  Bot Name <span className="text-accent">*</span>
                </label>
                <input
                  type="text"
                  placeholder="e.g. coder, researcher, writer"
                  value={newBotName}
                  onChange={(e) => setNewBotName(e.target.value)}
                  disabled={isSubmitting}
                  autoFocus
                  required
                  className="w-full bg-panel text-sm text-ink px-3.5 py-2.5 rounded-xl border border-edge focus:outline-none focus:border-accent placeholder-faint"
                />
                <p className="text-[11px] text-muted mt-1">
                  Lowercase letters, digits, underscores or hyphens; start with a letter.
                </p>
              </div>

              <div>
                <label className="block text-xs md:text-sm font-medium text-ink mb-1.5">
                  Display Name (optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. Coder, Researcher, Writer"
                  value={newBotDisplayName}
                  onChange={(e) => setNewBotDisplayName(e.target.value)}
                  disabled={isSubmitting}
                  maxLength={64}
                  className="w-full bg-panel text-sm text-ink px-3.5 py-2.5 rounded-xl border border-edge focus:outline-none focus:border-accent placeholder-faint"
                />
                <p className="text-[11px] text-muted mt-1">
                  Shown in the UI. You can rename the bot later without changing its internal ID.
                </p>
              </div>

              <div>
                <label className="block text-xs md:text-sm font-medium text-ink mb-1.5">
                  Personality & Instructions (optional)
                </label>
                <textarea
                  rows={4}
                  placeholder="Describe your bot's role, tone, and system prompt..."
                  value={newBotSoul}
                  onChange={(e) => setNewBotSoul(e.target.value)}
                  disabled={isSubmitting}
                  className="w-full bg-panel text-sm text-ink px-3.5 py-2.5 rounded-xl border border-edge focus:outline-none focus:border-accent placeholder-faint"
                />
              </div>

              <div className="flex items-center justify-end space-x-2 pt-2 border-t border-hair">
                <button
                  type="button"
                  onClick={() => setIsCreateOpen(false)}
                  disabled={isSubmitting}
                  className="px-4 py-2 rounded-xl text-xs md:text-sm font-medium text-muted hover:text-ink hover:bg-neutral transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !newBotName.trim()}
                  className="px-4 py-2 rounded-xl text-xs md:text-sm font-semibold bg-accent hover:bg-accent-strong text-white transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shadow-xs"
                >
                  {isSubmitting ? 'Creating...' : 'Create Bot'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Rename Bot Modal Dialog */}
      {renameTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-in fade-in duration-150">
          <div
            className="w-full max-w-md max-h-[90dvh] overflow-y-auto bg-surface border border-edge rounded-[26px] shadow-2xl p-6 space-y-4 animate-in zoom-in-95 duration-150"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-bot-title"
          >
            <div className="flex items-center justify-between pb-3 border-b border-hair">
              <div className="flex items-center space-x-2.5">
                <div className="w-8 h-8 rounded-full bg-accent-soft flex items-center justify-center text-accent">
                  <Pencil size={15} />
                </div>
                <div>
                  <h3 id="rename-bot-title" className="text-base font-semibold text-ink">
                    Bot identity
                  </h3>
                  <p className="text-xs text-muted">Edit name, labels and role.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setRenameTarget(null)}
                disabled={isRenaming}
                className="p-1.5 rounded-full text-faint hover:text-ink hover:bg-neutral transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {renameError && (
              <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs" role="alert">
                {renameError}
              </div>
            )}

            <form onSubmit={handleRenameBot} className="space-y-4">
              <label className="block text-xs font-medium text-ink">Labels (comma separated)
                <input aria-label="Bot labels" value={renameTags} onChange={e => setRenameTags(e.target.value)} disabled={isRenaming} className="mt-1 w-full rounded-xl border border-edge bg-panel p-3 text-sm" placeholder="Research, Coding" />
              </label>
              <label className="block text-xs font-medium text-ink">Role
                <textarea aria-label="Bot role" value={renameRole} onChange={e => setRenameRole(e.target.value)} disabled={isRenaming} maxLength={2000} className="mt-1 w-full rounded-xl border border-edge bg-panel p-3 text-sm" rows={2} />
              </label>
              <p className="text-xs text-muted">Name, labels and role sync to SOUL.md and the team roster. Your other personality instructions are preserved.</p>
              <div>
                <label className="block text-xs md:text-sm font-medium text-ink mb-1.5">
                  Display Name <span className="text-accent">*</span>
                </label>
                <input
                  type="text"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  disabled={isRenaming}
                  maxLength={64}
                  autoFocus
                  required
                  className="w-full bg-panel text-sm text-ink px-3.5 py-2.5 rounded-xl border border-edge focus:outline-none focus:border-accent placeholder-faint"
                />
                <p className="text-[11px] text-muted mt-1">
                  The internal ID stays <span className="font-mono">{renameTarget.id}</span>, so the bot keeps its workspace, sessions, and browser profile.
                </p>
              </div>

              <div className="flex items-center justify-end space-x-2 pt-2 border-t border-hair">
                <button
                  type="button"
                  onClick={() => setRenameTarget(null)}
                  disabled={isRenaming}
                  className="px-4 py-2 rounded-xl text-xs md:text-sm font-medium text-muted hover:text-ink hover:bg-neutral transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isRenaming || !renameValue.trim()}
                  className="px-4 py-2 rounded-xl text-xs md:text-sm font-semibold bg-accent hover:bg-accent-strong text-white transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shadow-xs"
                >
                  {isRenaming ? 'Saving...' : 'Save identity'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Bot Modal Dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-in fade-in duration-150">
          <div
            className="w-full max-w-md max-h-[90dvh] overflow-y-auto bg-surface border border-edge rounded-[26px] p-6 space-y-4 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-bot-title"
          >
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-red-50 p-2.5 text-red-600">
                <Trash2 size={18} />
              </div>
              <div>
                <h3 id="delete-bot-title" className="text-base font-semibold text-ink">
                  Delete {agents.find((b) => b.id === deleteTarget)?.name || deleteTarget}?
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  This removes the bot profile from Hermes. Its private workspace, conversations, credentials, and memory will no longer be available through Hob.
                </p>
              </div>
            </div>
            {deleteError && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700" role="alert">
                {deleteError}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 border-t border-hair pt-3">
              <button
                type="button"
                className={buttonClass}
                disabled={isDeleting}
                onClick={() => {
                  setDeleteTarget(null);
                  setDeleteError(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-xl bg-red-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer shadow-xs"
                disabled={isDeleting}
                onClick={() => void handleDeleteBot()}
              >
                <Trash2 size={13} />
                {isDeleting ? 'Deleting…' : 'Delete bot'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Disband Group Modal Dialog */}
      {disbandTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-in fade-in duration-150">
          <div
            className="w-full max-w-md max-h-[90dvh] overflow-y-auto bg-surface border border-edge rounded-[26px] p-6 space-y-4 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="disband-group-title"
          >
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-red-50 p-2.5 text-red-600">
                <Users size={18} />
              </div>
              <div>
                <h3 id="disband-group-title" className="text-base font-semibold text-ink">
                  Disband {disbandTarget.name}?
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  Disbanding cancels this group’s work. Its retained history stays readable under Hermes’s retention policy.
                </p>
              </div>
            </div>
            {groupError && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700" role="alert">
                {groupError}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 border-t border-hair pt-3">
              <button type="button" className={buttonClass} disabled={isGroupBusy} onClick={() => { setDisbandTarget(null); setGroupError(''); }}>
                Cancel
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-xl bg-red-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer shadow-xs"
                disabled={isGroupBusy}
                onClick={() => void disbandGroup(disbandTarget.id)}
              >
                <Trash2 size={13} />
                {isGroupBusy ? 'Disbanding…' : 'Disband group'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

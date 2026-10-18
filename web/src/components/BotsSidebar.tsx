import React, { useState, useMemo } from 'react';
import {
  Plus,
  Search,
  Settings,
  X,
  Sparkles,
  Trash2,
  MoreHorizontal,
} from 'lucide-react';
import { useChat } from '../context/ChatContext';
import { useRuntime } from '../context/RuntimeContext';
import { DogeshAvatar } from './DogeshAvatar';
import { apiFetch } from '../services/api';
import { buttonClass } from './WorkspaceUI';

interface BotsSidebarProps {
  onSelectBot?: (botId: string) => void;
}

export const BotsSidebar: React.FC<BotsSidebarProps> = ({ onSelectBot }) => {
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
  } = useChat();
  const runtime = useRuntime();

  const [search, setSearch] = useState('');
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newBotName, setNewBotName] = useState('');
  const [newBotSoul, setNewBotSoul] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Filter bots by search query
  const filteredAgents = useMemo(() => {
    if (!search.trim()) return agents;
    const q = search.toLowerCase();
    return agents.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        b.id.toLowerCase().includes(q) ||
        (b.model && b.model.toLowerCase().includes(q)) ||
        (b.roleDescription && b.roleDescription.toLowerCase().includes(q))
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
      if (runtime === 'hermes') {
        await apiFetch('/api/hermes/profiles', {
          method: 'POST',
          body: JSON.stringify({ name: cleanName, soul: newBotSoul.trim() }),
        });
      } else {
        await apiFetch('/api/agents', {
          method: 'POST',
          body: JSON.stringify({ name: cleanName }),
        });
      }
      await refresh();
      await selectAgent(cleanName);
      setNewBotName('');
      setNewBotSoul('');
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
                ? isPreparing
                  ? 'Preparing bot...'
                  : connected
                  ? 'Active now'
                  : 'Offline'
                : bot.model
                ? bot.model
                : bot.roleDescription || 'Available';

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
                      <span
                        className={`text-[14.5px] font-semibold truncate ${
                          isSelected ? 'text-code-strong' : 'text-ink'
                        }`}
                      >
                        {bot.name}
                      </span>

                      <div className="shrink-0 flex items-center gap-1">
                        {isSelected && !filteringActivity && (
                          <div className="p-1 text-accent hover:bg-accent-line rounded-md transition-colors">
                            <MoreHorizontal size={16} />
                          </div>
                        )}
                        {!isCurrent && !isSelected && (
                          <span className="w-2 h-2 rounded-full bg-ok-dot opacity-70" />
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
            className="w-full max-w-md bg-surface border border-edge rounded-[26px] shadow-2xl p-6 space-y-4 animate-in zoom-in-95 duration-150"
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

      {/* Delete Bot Modal Dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-in fade-in duration-150">
          <div
            className="w-full max-w-md bg-surface border border-edge rounded-[26px] p-6 space-y-4 shadow-2xl"
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
    </>
  );
};

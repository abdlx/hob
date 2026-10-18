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

export const BotsSidebar: React.FC = () => {
  const {
    agents,
    agent,
    selectAgent,
    connected,
    isPreparing,
    setActiveNav,
    refresh,
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
        className="hob-bots-sidebar flex-1 min-w-0 h-full flex flex-col bg-[#FAFAFA] select-none"
        aria-label="Bots directory"
      >
        {/* Header: Bots, badge, + button */}
        <div className="px-5 pt-6 pb-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-[17px] font-semibold text-[#17191D] tracking-tight">Bots</h2>
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#F0F0F0] text-[#687588]">
              {agents.length}
            </span>
          </div>

          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            title="Create new bot"
            aria-label="Create new bot"
            className="w-8 h-8 rounded-full flex items-center justify-center text-[#253041] hover:bg-[#F0F0F0] transition-colors cursor-pointer"
          >
            <Plus size={18} strokeWidth={2} />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-2">
          <div className="relative flex items-center">
            <Search
              size={15}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#8792A1] pointer-events-none"
            />
            <input
              type="text"
              placeholder="Search bots..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-10 bg-[#F0F0F0] text-[13px] text-[#17191D] pl-9 pr-12 rounded-full border border-transparent focus:border-[#1677FF]/40 focus:outline-none placeholder-[#8792A1] transition-all"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[#8792A1] hover:text-[#17191D] p-1 cursor-pointer"
              >
                <X size={13} />
              </button>
            ) : (
              <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[11px] font-medium text-[#8792A1] pointer-events-none select-none">
                ⌘ K
              </span>
            )}
          </div>
        </div>

        {/* Contacts / Bots List */}
        <div className="flex-1 overflow-y-auto px-3 py-1 space-y-1" role="list">
          {filteredAgents.length === 0 ? (
            <div className="text-center py-8 px-4 text-[#8792A1]">
              <p className="text-xs">No bots match "{search}".</p>
            </div>
          ) : (
            filteredAgents.map((bot) => {
              const isSelected = bot.id === (agent?.id || '');
              const avatar =
                bot.avatarUrl ||
                (isSelected && agent?.avatarUrl ? agent.avatarUrl : '/brand/hob-mark.png');
              const botStatus = isSelected
                ? connected
                  ? 'connected'
                  : isPreparing
                  ? 'busy'
                  : 'disconnected'
                : 'connected';

              const subtitle = isSelected
                ? isPreparing
                  ? 'Preparing bot...'
                  : connected
                  ? 'Active now'
                  : 'Offline'
                : bot.model
                ? bot.model
                : bot.roleDescription || 'Available';

              return (
                <div
                  key={bot.id}
                  onClick={() => void selectAgent(bot.id)}
                  role="listitem"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      void selectAgent(bot.id);
                    }
                  }}
                  className={`group relative flex items-center gap-3 p-2.5 h-[64px] rounded-[18px] cursor-pointer transition-all duration-150 ${
                    isSelected
                      ? 'bg-[#E5EEFB] text-[#17202E]'
                      : 'bg-transparent hover:bg-[#F0F0F0] text-[#17191D]'
                  }`}
                >
                  {/* Avatar with status indicator */}
                  <div className="relative shrink-0">
                    <DogeshAvatar
                      size={42}
                      showEditBadge={false}
                      avatarUrl={avatar}
                      status={botStatus}
                      ringColor={isSelected ? 'ring-[#E5EEFB]' : 'ring-[#FAFAFA]'}
                    />
                  </div>

                  {/* Info details */}
                  <div className="flex-1 min-w-0 pr-1">
                    <div className="flex items-center justify-between gap-1">
                      <span
                        className={`text-[14.5px] font-semibold truncate ${
                          isSelected ? 'text-[#17202E]' : 'text-[#17191D]'
                        }`}
                      >
                        {bot.name}
                      </span>

                      <div className="shrink-0 flex items-center gap-1">
                        {isSelected && (
                          <div className="p-1 text-[#1677FF] hover:bg-[#D5E5FA] rounded-md transition-colors">
                            <MoreHorizontal size={16} />
                          </div>
                        )}
                        {!isSelected && (
                          <span className="w-2 h-2 rounded-full bg-[#16CC8A] opacity-70" />
                        )}
                        {runtime === 'hermes' && bot.id !== 'default' && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setDeleteError(null);
                              setDeleteTarget(bot.id);
                            }}
                            className="rounded-md p-1 text-[#8792A1] opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 focus-visible:opacity-100 cursor-pointer"
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
                        isSelected ? 'text-[#687588]' : 'text-[#8792A1]'
                      }`}
                    >
                      {subtitle}
                    </p>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer: + New Bot and Manage in Settings */}
        <div className="p-4 pt-2 border-t border-[rgba(25,35,50,0.06)] bg-[#FAFAFA] space-y-2.5">
          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            className="w-full h-[46px] rounded-full bg-[#F1F1F1] hover:bg-[#E8E8E8] text-[#17191D] text-[13.5px] font-semibold flex items-center justify-center gap-2 transition-all cursor-pointer active:scale-[0.98]"
          >
            <Plus size={16} strokeWidth={2.2} />
            <span>New Bot</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveNav('settings')}
            className="w-full flex items-center justify-center gap-1.5 py-1 text-[#687588] hover:text-[#17191D] text-[12.5px] font-medium transition-colors cursor-pointer"
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
            className="w-full max-w-md bg-white border border-[rgba(25,35,50,0.1)] rounded-[26px] shadow-2xl p-6 space-y-4 animate-in zoom-in-95 duration-150"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <div className="flex items-center justify-between pb-3 border-b border-[rgba(25,35,50,0.08)]">
              <div className="flex items-center space-x-2.5">
                <div className="w-8 h-8 rounded-full bg-[#E5EEFB] flex items-center justify-center text-[#1677FF]">
                  <Sparkles size={16} />
                </div>
                <div>
                  <h3 id="modal-title" className="text-base font-semibold text-[#17191D]">
                    Create New Bot
                  </h3>
                  <p className="text-xs text-[#687588]">Add a contact with its own personality</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsCreateOpen(false)}
                className="p-1.5 rounded-full text-[#8792A1] hover:text-[#17191D] hover:bg-[#F0F0F0] transition-colors cursor-pointer"
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
                <label className="block text-xs md:text-sm font-medium text-[#17191D] mb-1.5">
                  Bot Name <span className="text-[#1677FF]">*</span>
                </label>
                <input
                  type="text"
                  placeholder="e.g. coder, researcher, writer"
                  value={newBotName}
                  onChange={(e) => setNewBotName(e.target.value)}
                  disabled={isSubmitting}
                  autoFocus
                  required
                  className="w-full bg-[#F7F7F7] text-sm text-[#17191D] px-3.5 py-2.5 rounded-xl border border-[rgba(25,35,50,0.1)] focus:outline-none focus:border-[#1677FF] placeholder-[#8792A1]"
                />
                <p className="text-[11px] text-[#687588] mt-1">
                  Lowercase letters, digits, underscores or hyphens; start with a letter.
                </p>
              </div>

              <div>
                <label className="block text-xs md:text-sm font-medium text-[#17191D] mb-1.5">
                  Personality & Instructions (optional)
                </label>
                <textarea
                  rows={4}
                  placeholder="Describe your bot's role, tone, and system prompt..."
                  value={newBotSoul}
                  onChange={(e) => setNewBotSoul(e.target.value)}
                  disabled={isSubmitting}
                  className="w-full bg-[#F7F7F7] text-sm text-[#17191D] px-3.5 py-2.5 rounded-xl border border-[rgba(25,35,50,0.1)] focus:outline-none focus:border-[#1677FF] placeholder-[#8792A1]"
                />
              </div>

              <div className="flex items-center justify-end space-x-2 pt-2 border-t border-[rgba(25,35,50,0.08)]">
                <button
                  type="button"
                  onClick={() => setIsCreateOpen(false)}
                  disabled={isSubmitting}
                  className="px-4 py-2 rounded-xl text-xs md:text-sm font-medium text-[#687588] hover:text-[#17191D] hover:bg-[#F0F0F0] transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !newBotName.trim()}
                  className="px-4 py-2 rounded-xl text-xs md:text-sm font-semibold bg-[#1677FF] hover:bg-[#0D6CE5] text-white transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shadow-xs"
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
            className="w-full max-w-md bg-white border border-[rgba(25,35,50,0.1)] rounded-[26px] p-6 space-y-4 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-bot-title"
          >
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-red-50 p-2.5 text-red-600">
                <Trash2 size={18} />
              </div>
              <div>
                <h3 id="delete-bot-title" className="text-base font-semibold text-[#17191D]">
                  Delete {agents.find((b) => b.id === deleteTarget)?.name || deleteTarget}?
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-[#687588]">
                  This removes the bot profile from Hermes. Its private workspace, conversations, credentials, and memory will no longer be available through Hob.
                </p>
              </div>
            </div>
            {deleteError && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700" role="alert">
                {deleteError}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 border-t border-[rgba(25,35,50,0.08)] pt-3">
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

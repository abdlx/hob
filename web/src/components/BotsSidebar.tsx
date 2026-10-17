import React, { useState, useMemo } from 'react';
import {
  Bot,
  Plus,
  Search,
  ChevronLeft,
  ChevronRight,
  Settings,
  X,
  Sparkles,
  Check,
} from 'lucide-react';
import { useChat } from '../context/ChatContext';
import { useRuntime } from '../context/RuntimeContext';
import { DogeshAvatar } from './DogeshAvatar';
import { apiFetch } from '../services/api';

export const BotsSidebar: React.FC = () => {
  const {
    agents,
    agent,
    selectAgent,
    connected,
    isPreparing,
    isBotsSidebarOpen,
    toggleBotsSidebar,
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

  // Keep a compact avatar rail visible when collapsed so bot switching remains
  // available without taking the names and details out of the expanded layout.
  if (!isBotsSidebarOpen) {
    return (
      <aside
        className="hidden md:flex flex-col items-center w-[72px] xl:w-[78px] h-full bg-[#120f0d] border-r border-[#27211a] shrink-0 select-none z-30 transition-all duration-200"
        aria-label="Collapsed bots sidebar"
      >
        <button
          type="button"
          onClick={toggleBotsSidebar}
          className="mt-3 mb-2 p-1.5 rounded-lg text-[#8c8072] hover:text-[#ff965c] hover:bg-[#251e17] transition-colors"
          aria-label="Expand Bots sidebar"
          title="Expand bots sidebar"
        >
          <ChevronRight size={14} />
        </button>

        <div className="w-full flex-1 overflow-y-auto flex flex-col items-center gap-2 px-2 py-2" role="list" aria-label="Bots">
          {agents.map((bot) => {
            const isSelected = bot.id === (agent?.id || '');
            const avatar = bot.avatarUrl || (isSelected && agent?.avatarUrl ? agent.avatarUrl : '/brand/hob-mark.png');
            const botStatus = isSelected
              ? connected
                ? 'connected'
                : isPreparing
                ? 'busy'
                : 'disconnected'
              : 'connected';

            return (
              <button
                key={bot.id}
                type="button"
                role="listitem"
                onClick={() => void selectAgent(bot.id)}
                className={`relative rounded-2xl p-1 transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff965c] ${
                  isSelected
                    ? 'bg-[#3a2416] ring-1 ring-[#ff965c]/70 shadow-[0_0_16px_rgba(255,150,92,0.18)]'
                    : 'hover:bg-[#251b14]'
                }`}
                aria-label={`Select ${bot.name}${isSelected ? ' (active)' : ''}`}
                aria-current={isSelected ? 'true' : undefined}
                title={bot.name}
              >
                <DogeshAvatar
                  size={44}
                  showEditBadge={false}
                  avatarUrl={avatar}
                  status={botStatus}
                />
                {isSelected && (
                  <span className="absolute -right-0.5 -top-0.5 w-2.5 h-2.5 rounded-full bg-[#ff965c] ring-2 ring-[#120f0d]" aria-hidden="true" />
                )}
              </button>
            );
          })}
          {agents.length === 0 && (
            <span className="px-1 text-center text-[10px] leading-tight text-[#8a7e6f]">No bots</span>
          )}
        </div>

        <button
          type="button"
          onClick={() => {
            setIsCreateOpen(true);
            toggleBotsSidebar();
          }}
          className="mb-3 p-2 rounded-xl text-[#b8ab9a] hover:text-[#ff965c] hover:bg-[#251e17] border border-transparent hover:border-[#3d2f23] transition-colors"
          aria-label="Create new bot"
          title="Create new bot"
        >
          <Plus size={16} />
        </button>
      </aside>
    );
  }

  return (
    <>
      {/* Desktop Inline Sidebar & Mobile Overlay */}
      <aside
        className="hob-bots-sidebar w-[272px] xl:w-[290px] h-full flex flex-col bg-[#120f0d] border-r border-[#27211a] shrink-0 select-none z-30 transition-all duration-200"
        aria-label="Bots directory"
      >
        {/* Header */}
        <div className="p-3.5 pb-2.5 border-b border-[#241e18] flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className="w-7 h-7 rounded-lg bg-[#271d15] border border-[#443122] flex items-center justify-center text-[#ff965c]">
              <Bot size={16} />
            </div>
            <div className="flex items-center space-x-1.5">
              <h2 className="text-sm font-semibold text-[#f2ebe2] tracking-tight">Bots</h2>
              <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[#201a14] border border-[#382d22] text-[#b3a595]">
                {agents.length}
              </span>
            </div>
          </div>

          <div className="flex items-center space-x-1">
            <button
              type="button"
              onClick={() => setIsCreateOpen(true)}
              title="Create new bot"
              aria-label="Create new bot"
              className="p-1.5 rounded-lg text-[#b8ab9a] hover:text-[#f8eee4] hover:bg-[#251e17] border border-transparent hover:border-[#3d2f23] transition-colors cursor-pointer"
            >
              <Plus size={16} />
            </button>
            <button
              type="button"
              onClick={toggleBotsSidebar}
              title="Collapse bots sidebar"
              aria-label="Collapse bots sidebar"
              className="p-1.5 rounded-lg text-[#8f8373] hover:text-[#f8eee4] hover:bg-[#251e17] transition-colors cursor-pointer"
            >
              <ChevronLeft size={16} />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="p-3 pb-2">
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[#7f7363]"
            />
            <input
              type="text"
              placeholder="Search bots..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-[#181410] text-xs md:text-[13px] text-[#eee4d5] pl-8.5 pr-3 py-2 rounded-xl border border-[#2b221a] focus:outline-none focus:border-[#ff965c] placeholder-[#6d6356] transition-colors"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#7f7363] hover:text-[#eee4d5]"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        {/* Contacts / Bots List */}
        <div className="flex-1 overflow-y-auto px-2.5 py-1 space-y-1.5" role="list">
          {filteredAgents.length === 0 ? (
            <div className="text-center py-8 px-4 text-[#8a7e6f]">
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
                  className={`group relative flex items-center gap-3 p-2.5 rounded-2xl cursor-pointer transition-all duration-150 border ${
                    isSelected
                      ? 'bg-[#251a12] border-[#553723] text-white shadow-sm ring-1 ring-[#ff965c]/25'
                      : 'bg-[#15110e]/50 hover:bg-[#1c1611] border-[#251d16]/70 hover:border-[#382b1f] text-[#b3a696]'
                  }`}
                >
                  {/* Avatar with status indicator */}
                  <div className="relative shrink-0">
                    <DogeshAvatar
                      size={44}
                      showEditBadge={false}
                      avatarUrl={avatar}
                      status={botStatus}
                    />
                  </div>

                  {/* Info details */}
                  <div className="flex-1 min-w-0 pr-1">
                    <div className="flex items-center justify-between gap-1">
                      <span
                        className={`text-sm font-semibold truncate ${
                          isSelected ? 'text-[#ffad80]' : 'text-[#eae1d4] group-hover:text-white'
                        }`}
                      >
                        {bot.name}
                      </span>
                      {isSelected && (
                        <span className="shrink-0 flex items-center space-x-1 text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-md bg-[#3e2515] text-[#ff9e63] border border-[#5d371d]">
                          <Check size={10} strokeWidth={2.5} />
                          <span>Active</span>
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[#8c8071] truncate mt-0.5 group-hover:text-[#a89c8c]">
                      {subtitle}
                    </p>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer / Manage Actions */}
        <div className="p-3 border-t border-[#241e18] bg-[#100d0b] space-y-2">
          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            className="w-full flex items-center justify-center space-x-2 py-2.5 px-3 bg-[#201812] hover:bg-[#2b1f16] text-[#f4eee5] text-xs md:text-sm font-medium rounded-xl border border-[#3b2b1e] hover:border-[#ff965c]/40 transition-all cursor-pointer shadow-xs active:scale-[0.98]"
          >
            <Plus size={15} className="text-[#ff965c]" />
            <span>New Bot</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveNav('settings')}
            className="w-full flex items-center justify-center space-x-1.5 py-1.5 px-2 text-[#8d8071] hover:text-[#dfd4c5] text-xs transition-colors cursor-pointer"
          >
            <Settings size={13} />
            <span>Manage in Settings</span>
          </button>
        </div>
      </aside>

      {/* Create Bot Modal Dialog */}
      {isCreateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs animate-in fade-in duration-150">
          <div
            className="w-full max-w-md bg-[#16120f] border border-[#382b1f] rounded-2xl shadow-2xl p-5 space-y-4 animate-in zoom-in-95 duration-150"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <div className="flex items-center justify-between pb-2 border-b border-[#282018]">
              <div className="flex items-center space-x-2">
                <div className="w-8 h-8 rounded-xl bg-[#281b12] border border-[#4a3220] flex items-center justify-center text-[#ff965c]">
                  <Sparkles size={16} />
                </div>
                <div>
                  <h3 id="modal-title" className="text-base font-semibold text-[#f4ece3]">
                    Create New Bot
                  </h3>
                  <p className="text-xs text-[#8c8072]">Add a contact with its own personality</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsCreateOpen(false)}
                className="p-1.5 rounded-xl text-[#8f8373] hover:text-white hover:bg-[#251e17] transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {createError && (
              <div className="p-3 rounded-xl bg-red-950/40 border border-red-900/50 text-red-200 text-xs">
                {createError}
              </div>
            )}

            <form onSubmit={handleCreateBot} className="space-y-4">
              <div>
                <label className="block text-xs md:text-sm font-medium text-[#dcd1c2] mb-1.5">
                  Bot Name <span className="text-[#ff965c]">*</span>
                </label>
                <input
                  type="text"
                  placeholder="e.g. coder, researcher, writer"
                  value={newBotName}
                  onChange={(e) => setNewBotName(e.target.value)}
                  disabled={isSubmitting}
                  autoFocus
                  required
                  className="w-full bg-[#1c1611] text-sm text-[#eee4d5] px-3.5 py-2.5 rounded-xl border border-[#33261c] focus:outline-none focus:border-[#ff965c] placeholder-[#6d6356]"
                />
                <p className="text-[11px] text-[#857969] mt-1">
                  Lowercase letters, digits, underscores or hyphens; start with a letter.
                </p>
              </div>

              <div>
                <label className="block text-xs md:text-sm font-medium text-[#dcd1c2] mb-1.5">
                  Personality & Instructions (optional)
                </label>
                <textarea
                  rows={4}
                  placeholder="Describe your bot's role, tone, and system prompt..."
                  value={newBotSoul}
                  onChange={(e) => setNewBotSoul(e.target.value)}
                  disabled={isSubmitting}
                  className="w-full bg-[#1c1611] text-sm text-[#eee4d5] px-3.5 py-2.5 rounded-xl border border-[#33261c] focus:outline-none focus:border-[#ff965c] placeholder-[#6d6356]"
                />
              </div>

              <div className="flex items-center justify-end space-x-2 pt-2 border-t border-[#282018]">
                <button
                  type="button"
                  onClick={() => setIsCreateOpen(false)}
                  disabled={isSubmitting}
                  className="px-4 py-2 rounded-xl text-xs md:text-sm font-medium text-[#a89c8b] hover:text-white hover:bg-[#201a14] transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !newBotName.trim()}
                  className="px-4 py-2 rounded-xl text-xs md:text-sm font-medium bg-[#ff965c] hover:bg-[#ff8642] text-[#1a120b] transition-all cursor-pointer font-semibold disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                >
                  {isSubmitting ? 'Creating...' : 'Create Bot'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
};

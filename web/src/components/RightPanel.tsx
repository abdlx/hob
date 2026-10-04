import React from 'react';
import { useChat } from '../context/ChatContext';
import { DogeshAvatar } from './DogeshAvatar';
import {
  List,
  Shield,
  CircleDot,
  Asterisk,
  CheckCircle2,
  FileText,
  X,
  Check,
  Server,
} from 'lucide-react';

export const RightPanel: React.FC = () => {
  const {
    agent,
    tasks,
    approvals,
    stats,
    activeTab,
    setActiveTab,
    isRightPanelOpen,
    toggleRightPanel,
    resolveApproval,
    updateAgent,
  } = useChat();

  if (!isRightPanelOpen) return null;

  return (
    <aside className="w-[275px] max-w-[85vw] bg-black border-l border-[#181818] flex flex-col h-full shrink-0 select-none overflow-hidden relative max-md:fixed max-md:right-0 max-md:top-0 max-md:z-30 max-md:shadow-2xl">
      {/* Top right close button */}
      <button
        onClick={toggleRightPanel}
        title="Close panel"
        className="absolute top-3.5 right-3.5 p-1.5 rounded-full text-white hover:bg-[#181818] transition-colors cursor-pointer z-10"
      >
        <X size={14} strokeWidth={2} />
      </button>

      {/* Top Agent Profile Card */}
      <div className="pt-5 pb-3 px-4 flex flex-col items-center">
        <DogeshAvatar
          size={64}
          showEditBadge={true}
          avatarUrl={agent?.avatarUrl || '/dogesh.png'}
          onEditClick={() => {
            const newName = prompt('Rename agent:', agent?.name || 'Dogesh');
            if (newName && agent) {
              updateAgent({ name: newName });
            }
          }}
        />

        <h2 className="mt-2 text-[14px] font-semibold text-white tracking-tight">
          {agent?.name || 'Dogesh'}
        </h2>

        {/* Status indicator */}
        <div className="flex items-center space-x-1.5 mt-0.5">
          <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e] inline-block shadow-[0_0_5px_rgba(34,197,94,0.7)]" />
          <span className="text-[11px] font-normal text-[#8a8883]">
            Connected
          </span>
        </div>

        {/* 4-Tab Icon Switcher Bar - All Icons White */}
        <div className="w-full mt-3 bg-[#111111] border border-[#1f1f1f] rounded-full p-0.5 flex items-center justify-between">
          <button
            onClick={() => setActiveTab('tasks')}
            title="Tasks & Activity"
            className={`flex-1 py-1.5 rounded-full flex items-center justify-center transition-colors cursor-pointer text-white ${
              activeTab === 'tasks' ? 'bg-[#242424] shadow-xs' : 'hover:bg-[#1a1a1a]'
            }`}
          >
            <List size={14} strokeWidth={2} />
          </button>

          <button
            onClick={() => setActiveTab('security')}
            title="Security"
            className={`flex-1 py-1.5 rounded-full flex items-center justify-center transition-colors cursor-pointer text-white ${
              activeTab === 'security' ? 'bg-[#242424] shadow-xs' : 'hover:bg-[#1a1a1a]'
            }`}
          >
            <Shield size={14} strokeWidth={1.8} />
          </button>

          <button
            onClick={() => setActiveTab('stats')}
            title="System & Metrics"
            className={`flex-1 py-1.5 rounded-full flex items-center justify-center transition-colors cursor-pointer text-white ${
              activeTab === 'stats' ? 'bg-[#242424] shadow-xs' : 'hover:bg-[#1a1a1a]'
            }`}
          >
            <CircleDot size={14} strokeWidth={1.8} />
          </button>

          <button
            onClick={() => setActiveTab('skills')}
            title="Skills & Tools"
            className={`flex-1 py-1.5 rounded-full flex items-center justify-center transition-colors cursor-pointer text-white ${
              activeTab === 'skills' ? 'bg-[#242424] shadow-xs' : 'hover:bg-[#1a1a1a]'
            }`}
          >
            <Asterisk size={14} strokeWidth={2.2} />
          </button>
        </div>
      </div>

      {/* Main Tab Content */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1">
        {/* TAB 1: Tasks / Activity Timeline (Default matching screenshot) */}
        {activeTab === 'tasks' && (
          <div>
            <div className="px-1 mb-1 mt-0.5">
              <span className="text-[11px] font-medium text-[#73716c]">
                Today
              </span>
            </div>

            <div className="space-y-0.5">
              {tasks.map((task) => {
                const isCheck =
                  task.id === 't-1' || task.id === 't-3' || task.id === 't-5';

                return (
                  <div
                    key={task.id}
                    className="p-1.5 rounded-xl hover:bg-[#121212] transition-all flex items-start space-x-2 cursor-pointer group"
                  >
                    {/* Rounded box containing the icon (icon is white) */}
                    <div className="w-[22px] h-[22px] rounded-full bg-[#141414] border border-[#222222] flex items-center justify-center shrink-0 mt-0.5 text-white">
                      {isCheck ? (
                        <CheckCircle2 size={12} strokeWidth={1.8} />
                      ) : (
                        <FileText size={12} strokeWidth={1.8} />
                      )}
                    </div>

                    {/* Task Info */}
                    <div className="flex-1 min-w-0 pr-0.5">
                      <div className="flex items-start justify-between gap-1">
                        <h4 className="text-[11px] font-medium leading-[1.3] text-[#dedcd8] line-clamp-2">
                          {task.title}
                        </h4>
                        <span className="text-[9.5px] text-[#55534e] shrink-0 self-start mt-0.5">
                          {task.timestamp}
                        </span>
                      </div>

                      {task.subtitle && (
                        <p className="text-[10px] text-[#706e69] mt-0.5 leading-[1.25] line-clamp-2">
                          {task.subtitle}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* TAB 2: Security & Approvals */}
        {activeTab === 'security' && (
          <div className="space-y-3 pt-2">
            <div className="px-1 flex items-center justify-between">
              <span className="text-xs font-semibold text-[#888888]">
                Tool Approvals
              </span>
              <span className="text-[11px] text-emerald-400">Sandbox Active</span>
            </div>

            {approvals.map((appr) => (
              <div
                key={appr.id}
                className="p-3 bg-[#111111] border border-[#1f1f1f] rounded-2xl space-y-2 text-xs"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-neutral-200 uppercase text-[10px] px-2 py-0.5 rounded-full bg-[#181818] border border-[#262626]">
                    {appr.type}
                  </span>
                  <span
                    className={`text-[10px] font-medium ${
                      appr.status === 'approved'
                        ? 'text-emerald-400'
                        : appr.status === 'rejected'
                        ? 'text-red-400'
                        : 'text-amber-400'
                    }`}
                  >
                    {appr.status}
                  </span>
                </div>

                <p className="text-neutral-300 text-[11px] leading-tight">
                  {appr.description}
                </p>

                {appr.commandSnippet && (
                  <pre className="p-2 bg-black rounded-xl text-[10px] text-amber-200 overflow-x-auto border border-[#222222] font-mono">
                    {appr.commandSnippet}
                  </pre>
                )}

                {appr.status === 'pending' && (
                  <div className="flex items-center space-x-2 pt-1">
                    <button
                      onClick={() => resolveApproval(appr.id, 'approved')}
                      className="flex-1 py-1 px-2 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-[11px] flex items-center justify-center space-x-1 cursor-pointer"
                    >
                      <Check size={12} className="text-white" />
                      <span>Approve</span>
                    </button>
                    <button
                      onClick={() => resolveApproval(appr.id, 'rejected')}
                      className="flex-1 py-1 px-2 rounded-full bg-[#242424] hover:bg-[#2e2e2e] text-neutral-300 text-[11px] cursor-pointer"
                    >
                      Deny
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* TAB 3: Metrics & System Stats */}
        {activeTab === 'stats' && (
          <div className="space-y-4 pt-2">
            <span className="text-xs font-semibold text-[#888888] px-1">
              Gateway Metrics
            </span>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="p-3 bg-[#111111] border border-[#1f1f1f] rounded-2xl flex flex-col">
                <span className="text-neutral-400 text-[10px]">Context Window</span>
                <span className="text-sm font-semibold text-neutral-100 mt-1">
                  {Math.round(((stats?.tokensUsed || 0) / (stats?.maxTokens || 128000)) * 100)}%
                </span>
                <span className="text-[10px] text-neutral-500 mt-0.5">
                  {(stats?.tokensUsed || 0).toLocaleString()} / {(stats?.maxTokens || 128000).toLocaleString()} toks
                </span>
              </div>

              <div className="p-3 bg-[#111111] border border-[#1f1f1f] rounded-2xl flex flex-col">
                <span className="text-neutral-400 text-[10px]">Turn Latency</span>
                <span className="text-sm font-semibold text-neutral-100 mt-1">
                  {stats?.latencyMs || 145} ms
                </span>
                <span className="text-[10px] text-emerald-400 mt-0.5">Normal</span>
              </div>

              <div className="p-3 bg-[#111111] border border-[#1f1f1f] rounded-2xl flex flex-col">
                <span className="text-neutral-400 text-[10px]">Memory Allocated</span>
                <span className="text-sm font-semibold text-neutral-100 mt-1">
                  {stats?.memoryUsageMb || 342} MB
                </span>
                <span className="text-[10px] text-neutral-500 mt-0.5">V8 / SQLite</span>
              </div>

              <div className="p-3 bg-[#111111] border border-[#1f1f1f] rounded-2xl flex flex-col">
                <span className="text-neutral-400 text-[10px]">Active Turns</span>
                <span className="text-sm font-semibold text-neutral-100 mt-1">
                  {stats?.activeProcesses || 1}
                </span>
                <span className="text-[10px] text-neutral-500 mt-0.5">1 background</span>
              </div>
            </div>

            <div className="p-3 bg-[#111111] border border-[#1f1f1f] rounded-2xl text-xs space-y-1.5">
              <div className="flex items-center space-x-1.5 text-neutral-300">
                <Server size={14} className="text-white" />
                <span className="font-medium text-xs">Runtime Engine</span>
              </div>
              <p className="text-[11px] text-neutral-400">
                Hermes-OpenClaw Gateway Core (Local Node Daemon)
              </p>
            </div>
          </div>
        )}

        {/* TAB 4: Skills & Capabilities */}
        {activeTab === 'skills' && (
          <div className="space-y-2 pt-2">
            <span className="text-xs font-semibold text-[#888888] px-1">
              Active Agent Capabilities
            </span>

            {[
              {
                name: 'Bash & Terminal',
                desc: 'Execute sandboxed commands in workspace',
                active: true,
              },
              {
                name: 'Filesystem I/O',
                desc: 'Read, modify and commit workspace files',
                active: true,
              },
              {
                name: 'Web Browsing & Search',
                desc: 'Live query lookup and documentation retrieval',
                active: true,
              },
              {
                name: 'Memory Core',
                desc: 'Long term SQLite embeddings & episodic memory',
                active: true,
              },
              {
                name: 'GitHub Portals',
                desc: 'Issue tracking & PR scaffolding',
                active: false,
              },
            ].map((skill, sIdx) => (
              <div
                key={sIdx}
                className="p-2.5 bg-[#111111] border border-[#1f1f1f] rounded-2xl flex items-center justify-between text-xs"
              >
                <div>
                  <h5 className="font-medium text-neutral-200 text-xs">
                    {skill.name}
                  </h5>
                  <p className="text-[10px] text-neutral-400 mt-0.5 leading-tight">
                    {skill.desc}
                  </p>
                </div>
                <div
                  className={`w-2 h-2 rounded-full ${
                    skill.active ? 'bg-emerald-500' : 'bg-neutral-600'
                  }`}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
};

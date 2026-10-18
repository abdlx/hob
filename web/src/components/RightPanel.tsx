import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Globe,
  FileText,
  X,
  Check,
  RefreshCw,
  Plus,
  Camera,
  Save,
  ArrowLeft,
  Info,
  Sliders,
  Settings,
  Search,
  Code2,
  Image as ImageIcon,
  Compass,
  ChevronLeft,
} from 'lucide-react';
import { useChat } from '../context/ChatContext';
import { useRuntime } from '../context/RuntimeContext';
import { apiFetch } from '../services/api';
import { DogeshAvatar } from './DogeshAvatar';
import { MarkdownView } from './MarkdownView';
import { DailyGoals } from '../pages/WorkspaceViews';
import { HermesBrowser, HermesIdentity } from '../pages/HermesWorkspace';
import { buttonClass, Field, inputClass, Notice, Skeleton } from './WorkspaceUI';
import { errorText } from './workspaceUtils';
import { MobileDock } from './MobileDock';
import type { RightPanelTab } from '../types/chat';

interface BrowserTab {
  targetId: string;
  title?: string;
  url?: string;
  type?: string;
}

function OpenClawBrowserPanel() {
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [selected, setSelected] = useState('');
  const [url, setUrl] = useState('');
  const [snapshot, setSnapshot] = useState('');
  const [screenshot, setScreenshot] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ tabs: BrowserTab[] }>('/api/browser/tabs');
      setTabs(data.tabs || []);
      setError('');
    } catch (error) {
      setError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(load, 0);
    return () => window.clearTimeout(initial);
  }, [load]);

  const action = async (action: string, targetId = selected) => {
    if ((action === 'navigate' || action === 'open') && !/^https?:\/\//i.test(url.trim())) {
      setError('Enter a full http:// or https:// address.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const data = await apiFetch<{
        snapshot?: string;
        text?: string;
        targetId?: string;
        imageUrl?: string;
        dataUrl?: string;
        url?: string;
        base64?: string;
        mimeType?: string;
      }>('/api/browser/actions', {
        method: 'POST',
        body: JSON.stringify({
          action,
          targetId: targetId || undefined,
          url: action === 'open' || action === 'navigate' ? url.trim() : undefined,
        }),
      });
      if (action === 'snapshot') {
        setSnapshot(data.snapshot || data.text || JSON.stringify(data, null, 2));
        setScreenshot('');
      }
      if (action === 'screenshot') {
        setScreenshot(
          data.imageUrl ||
            data.dataUrl ||
            (data.base64 ? `data:${data.mimeType || 'image/png'};base64,${data.base64}` : data.url || '')
        );
        if (!data.imageUrl && !data.dataUrl && !data.base64 && !data.url)
          setSnapshot(JSON.stringify(data, null, 2));
      }
      if (data.targetId) setSelected(data.targetId);
      if (action === 'close' && targetId === selected) {
        setSelected('');
        setSnapshot('');
        setScreenshot('');
      }
      await load();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3.5 pt-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">Browser</span>
        <button
          disabled={busy}
          title="Refresh browser tabs"
          onClick={load}
          className="text-muted hover:text-ink transition-colors p-1"
        >
          <RefreshCw size={15} />
        </button>
      </div>
      {error && <Notice error>{error}</Notice>}
      <div className="flex gap-2">
        <button disabled={busy} className={buttonClass} onClick={() => action('start')}>
          Start browser
        </button>
        <button disabled={busy || !url.trim()} className={buttonClass} onClick={() => action('open')}>
          <Plus size={14} />Tab
        </button>
      </div>
      <Field label="Address">
        <input
          className={inputClass}
          placeholder="https://example.com"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !busy) void action(selected ? 'navigate' : 'open');
          }}
        />
      </Field>
      <button
        disabled={busy || !selected || !url.trim()}
        className={buttonClass}
        onClick={() => action('navigate')}
      >
        Navigate selected tab
      </button>
      {loading ? (
        <div className="space-y-3"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>
      ) : tabs.length === 0 ? (
        <Notice>No open tabs. Start the browser and open an address.</Notice>
      ) : (
        tabs.map((tab) => (
          <div
            key={tab.targetId}
            className={`flex gap-2 rounded-xl border p-3 transition-colors ${
              selected === tab.targetId ? 'border-accent bg-accent-soft/40' : 'border-hair bg-surface'
            }`}
          >
            <button
              className="flex-1 min-w-0 text-left cursor-pointer"
              onClick={() => {
                setSelected(tab.targetId);
                setUrl(tab.url || '');
                setSnapshot('');
                setScreenshot('');
              }}
            >
              <p className="text-xs md:text-sm font-medium text-ink truncate">
                {tab.title || 'Untitled tab'}
              </p>
              <p className="text-xs text-muted truncate mt-0.5">{tab.url || tab.targetId}</p>
            </button>
            <button
              title="Close browser tab"
              disabled={busy}
              onClick={() => action('close', tab.targetId)}
              className="text-faint hover:text-ink p-1"
            >
              <X size={15} />
            </button>
          </div>
        ))
      )}
      <div className="flex gap-2">
        <button className={buttonClass} disabled={busy || !selected} onClick={() => action('snapshot')}>
          <FileText size={14} />Snapshot
        </button>
        <button
          aria-label="Capture browser screenshot"
          title="Capture browser screenshot"
          className={buttonClass}
          disabled={busy || !selected}
          onClick={() => action('screenshot')}
        >
          <Camera size={14} />
        </button>
      </div>
      {busy && <Notice>Waiting for the browser…</Notice>}
      {screenshot && (
        <img
          src={screenshot}
          alt="Current agent browser screenshot"
          className="w-full rounded-2xl border border-hair"
        />
      )}
      {snapshot && (
        <pre className="select-text whitespace-pre-wrap break-words max-h-[400px] overflow-auto text-xs leading-relaxed text-ink p-3.5 bg-surface rounded-xl border border-hair font-mono">
          {snapshot}
        </pre>
      )}
    </div>
  );
}

interface AgentFile {
  agentId: string;
  workspace: string;
  file: { name: string; content: string; hash?: string; missing?: boolean };
}

function OpenClawIdentityPanel() {
  const { agent, updateAgent } = useChat();
  const [identityEditing, setIdentityEditing] = useState(false);
  const [name, setName] = useState(agent?.name || '');
  const [avatarUrl, setAvatarUrl] = useState(agent?.avatarUrl || '');
  const [model, setModel] = useState(agent?.model || '');
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<AgentFile | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const fileRequest = useRef(0);

  useEffect(() => () => {
    fileRequest.current++;
  }, []);

  const agentId = agent?.id || 'main';
  const filePath = (fileName: string) =>
    `/api/agent/files/${encodeURIComponent(fileName)}?agentId=${encodeURIComponent(agentId)}`;

  const open = async (fileName: string) => {
    const request = ++fileRequest.current;
    setSelected(fileName);
    setFile(null);
    setDraft('');
    setEditing(false);
    setError('');
    setStatus('');
    setBusy(true);
    try {
      const result = await apiFetch<AgentFile>(filePath(fileName));
      if (request !== fileRequest.current) return;
      if (result.file.name !== fileName || result.agentId !== agentId)
        throw new Error('The gateway returned a different agent file. Please reopen the file.');
      setFile(result);
      setDraft(result.file.content || '');
    } catch (error) {
      if (request === fileRequest.current) setError(errorText(error));
    } finally {
      if (request === fileRequest.current) setBusy(false);
    }
  };

  const saveFile = async () => {
    if (!file || !selected || selected !== file.file.name || file.agentId !== agentId) return;
    const request = fileRequest.current;
    const target = file.file.name;
    setBusy(true);
    setError('');
    try {
      await apiFetch(filePath(target), {
        method: 'PUT',
        body: JSON.stringify({
          content: draft,
          ...(file.file.missing ? { expectedMissing: true } : { expectedHash: file.file.hash }),
          agentId: file.agentId,
        }),
      });
      if (request !== fileRequest.current) return;
      await open(target);
      if (fileRequest.current === request + 1) setStatus('File saved to the agent workspace.');
    } catch (error) {
      if (request === fileRequest.current) setError(errorText(error));
    } finally {
      if (request === fileRequest.current) setBusy(false);
    }
  };

  const saveIdentity = async () => {
    if (!name.trim()) {
      setError('Enter an agent name.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await updateAgent({
        id: agentId,
        name: name.trim(),
        ...(avatarUrl !== (agent?.avatarUrl || '') ? { avatarUrl } : {}),
        ...(model.trim() && model.trim() !== agent?.model ? { model: model.trim() } : {}),
      });
      setIdentityEditing(false);
      setStatus('Identity saved.');
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3.5 pt-2">
      {error && <Notice error>{error}</Notice>}
      {status && <Notice>{status}</Notice>}
      {selected ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <button
              className={buttonClass}
              onClick={() => {
                fileRequest.current++;
                setSelected(null);
                setFile(null);
                setDraft('');
                setEditing(false);
                setStatus('');
                setBusy(false);
              }}
            >
              <ArrowLeft size={14} /> Back
            </button>
            <span className="text-sm font-semibold text-ink font-mono">{selected}</span>
            {editing ? (
              <button disabled={busy} className={buttonClass} onClick={saveFile}>
                <Save size={14} />Save
              </button>
            ) : (
              <button disabled={busy || !file} className={buttonClass} onClick={() => setEditing(true)}>
                Edit
              </button>
            )}
          </div>
          {busy ? (
            <Skeleton className="h-40 w-full" />
          ) : file && editing ? (
            <>
              <textarea
                aria-label={`Edit ${selected}`}
                className={`${inputClass} font-mono min-h-[340px] text-xs md:text-sm leading-relaxed`}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              <button
                className={buttonClass}
                onClick={() => {
                  setDraft(file.file.content || '');
                  setEditing(false);
                }}
              >
                Cancel
              </button>
            </>
          ) : file?.file.missing ? (
            <Notice>{selected} has not been created yet. Click Edit to create it.</Notice>
          ) : file ? (
            <div className="p-3.5 bg-surface border border-hair rounded-2xl">
              <MarkdownView content={file.file.content} />
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted">Agent identity</span>
            <button
              className={buttonClass}
              onClick={() => {
                setName(agent?.name || '');
                setAvatarUrl(agent?.avatarUrl || '');
                setModel(agent?.model || '');
                setIdentityEditing(true);
              }}
            >
              <Plus size={14} />
              {agent?.name ? 'Edit identity' : 'Add identity'}
            </button>
          </div>
          {identityEditing && (
            <div className="space-y-3.5 rounded-2xl p-4 border border-hair bg-surface">
              <Field label="Name">
                <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} />
              </Field>
              <Field label="Avatar URL">
                <input
                  className={inputClass}
                  placeholder="https://…"
                  value={avatarUrl}
                  onChange={(event) => setAvatarUrl(event.target.value)}
                />
              </Field>
              <Field label="Model">
                <input
                  className={inputClass}
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="provider/model"
                />
              </Field>
              <div className="flex gap-2">
                <button disabled={busy} className={buttonClass} onClick={saveIdentity}>
                  Save identity
                </button>
                <button className={buttonClass} onClick={() => setIdentityEditing(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {agent?.roleDescription && (
            <p className="text-xs md:text-sm text-muted px-1 leading-relaxed">{agent.roleDescription}</p>
          )}
          {[
            { name: 'SOUL.md', title: 'Soul', description: 'Personality, values, and behavior' },
            { name: 'MEMORY.md', title: 'Memory', description: 'Long-term memory and context' },
          ].map((item) => (
            <button
              key={item.name}
              onClick={() => open(item.name)}
              className="w-full rounded-2xl border border-hair bg-surface text-left p-4 hover:border-accent/40 hover:bg-hover transition-all cursor-pointer space-y-1 shadow-xs"
            >
              <FileText size={20} className="text-accent mb-2" />
              <p className="text-sm font-semibold text-ink">{item.title}</p>
              <p className="text-xs text-muted mt-0.5 leading-relaxed">{item.description}</p>
              <p className="text-xs text-faint mt-1 font-mono">{item.name}</p>
            </button>
          ))}
        </>
      )}
    </div>
  );
}

function BrowserPanel() {
  const { agent } = useChat();
  const runtime = useRuntime();
  if (!agent) return <div className="space-y-3"><Skeleton className="h-9 w-full" /><Skeleton className="h-40 w-full" /></div>;
  return runtime === 'hermes' ? <HermesBrowser key={agent.id} profile={agent.id} /> : <OpenClawBrowserPanel />;
}

function IdentityPanel() {
  const { agent } = useChat();
  const runtime = useRuntime();
  if (!agent) return <div className="space-y-3"><Skeleton className="h-9 w-full" /><Skeleton className="h-40 w-full" /></div>;
  return runtime === 'hermes' ? <HermesIdentity key={agent.id} profile={agent.id} /> : <OpenClawIdentityPanel />;
}

// Fallback baseline activity items matching reference screenshot
const defaultActivityGroups = [
  {
    group: 'Today',
    items: [
      { id: '1', title: 'Initial greeting inquiry', time: '11:25 PM', icon: Compass },
      { id: '2', title: 'Searched the web', time: '11:20 PM', icon: Search },
      { id: '3', title: 'Executed Python script', time: '10:42 PM', icon: Code2 },
      { id: '4', title: 'Analyzed file', time: '9:18 PM', icon: FileText },
      { id: '5', title: 'Generated image', time: '7:03 PM', icon: ImageIcon },
    ],
  },
  {
    group: 'Yesterday',
    items: [
      { id: '6', title: 'Updated memory file', time: '11:14 PM', icon: FileText },
      { id: '7', title: 'Created task workflow', time: '6:02 PM', icon: Compass },
      { id: '8', title: 'Browsed documentation', time: '2:18 PM', icon: FileText },
    ],
  },
  {
    group: 'Oct 15',
    items: [
      { id: '9', title: 'Reviewed CLIP10 fallback file', time: '1:12 PM', icon: Compass },
    ],
  },
];

export function RightPanel() {
  const {
    agent,
    connected,
    tasks,
    approvals,
    activeTab,
    setActiveTab,
    isRightPanelOpen,
    toggleRightPanel,
    resolveApproval,
  } = useChat();

  const [error, setError] = useState('');
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);

  if (!isRightPanelOpen) return null;

  // The 5 Tabs matching the reference image: Info, Skills, Web, Files, Settings
  const tabs = [
    { id: 'tasks', label: 'Info', icon: Info },
    { id: 'security', label: 'Skills', icon: Sliders },
    { id: 'browser', label: 'Web', icon: Globe },
    { id: 'identity', label: 'Files', icon: FileText },
    { id: 'goals', label: 'Settings', icon: Settings },
  ] as const;

  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    setApprovalBusy(id);
    setError('');
    try {
      await resolveApproval(id, decision);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setApprovalBusy(null);
    }
  };

  // Group dynamic tasks if available
  const hasLiveTasks = tasks && tasks.length > 0;

  return (
    <div className="hob-agent-panel w-full h-full min-h-0 bg-canvas flex flex-col select-none overflow-hidden relative">
      {/* Mobile top bar with back button */}
      <div className="lg:hidden flex items-center justify-between px-4 py-3 border-b border-line shrink-0 bg-canvas">
        <button
          onClick={toggleRightPanel}
          className="flex items-center gap-1 text-[14px] font-medium text-accent hover:text-accent-strong p-1 -ml-1 cursor-pointer transition-colors"
          title="Back to chat"
          aria-label="Back to chat"
        >
          <ChevronLeft size={20} strokeWidth={2.4} />
          <span>Back</span>
        </button>
        <span className="text-[15px] font-semibold text-ink">Bot Activity</span>
        <button
          onClick={toggleRightPanel}
          className="w-8 h-8 rounded-full flex items-center justify-center text-muted hover:text-ink hover:bg-black/5 transition-colors cursor-pointer"
          title="Close"
          aria-label="Close"
        >
          <X size={18} strokeWidth={2} />
        </button>
      </div>

      {/* Desktop close button */}
      <button
        onClick={toggleRightPanel}
        title="Close panel"
        className="hidden lg:block absolute top-4 right-4 p-2 rounded-full text-muted hover:text-ink hover:bg-black/5 transition-colors cursor-pointer z-10"
      >
        <X size={18} strokeWidth={2} />
      </button>

      {/* Middle scrollable content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 sm:px-5 sm:py-4 lg:px-5 lg:py-5">

      {/* Profile Header */}
      <div className="flex flex-col items-center text-center">
        <DogeshAvatar
          size={78}
          showEditBadge
          avatarUrl={agent?.avatarUrl}
          onEditClick={() => setActiveTab('identity')}
          status={connected ? 'connected' : 'disconnected'}
          ringColor="ring-canvas"
        />

        <h2 className="mt-3 text-[17px] font-semibold text-ink tracking-tight">
          {agent?.name || 'Main'}
        </h2>

        <div className="flex items-center gap-1.5 mt-1">
          <span
            className={`w-2 h-2 rounded-full inline-block ${
              connected ? 'bg-ok-dot' : 'bg-faint'
            }`}
          />
          <span className="text-[13px] font-medium text-ink capitalize">
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>

        {/* 5-Tab Selector: Noticeably rounder pill container and pill highlight */}
        <div
          className="w-full mt-5 mb-5 bg-panel border border-line rounded-full p-[5px] h-[66px] flex items-center justify-between"
          role="tablist"
          aria-label="Agent panel"
        >
          {tabs.map(({ id, label, icon: Icon }) => {
            const isActive = activeTab === id;
            return (
              <button
                key={id}
                role="tab"
                aria-selected={isActive}
                aria-label={label}
                onClick={() => setActiveTab(id as RightPanelTab)}
                className={`flex-1 h-full rounded-full flex flex-col items-center justify-center transition-all cursor-pointer py-1 ${
                  isActive
                    ? 'bg-accent-soft text-accent'
                    : 'text-code hover:text-ink hover:bg-black/[0.02]'
                }`}
              >
                <Icon
                  size={17}
                  strokeWidth={isActive ? 2.2 : 1.8}
                  className={isActive ? 'text-accent' : 'text-code'}
                />
                <span
                  className={`text-[11px] font-medium mt-1 leading-none ${
                    isActive ? 'text-accent' : 'text-muted'
                  }`}
                >
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab Body */}
      <div className="flex-1 space-y-4">
        {/* Info Tab (Active default): About + Activity */}
        {activeTab === 'tasks' && (
          <div>
            {/* About Section */}
            <div className="mb-5 pb-5 border-b border-line">
              <h3 className="text-[14px] font-semibold text-ink mb-1.5">About</h3>
              <p className="text-[13px] text-muted leading-relaxed">
                {agent?.roleDescription ||
                  'General purpose assistant with full tool access and autonomous capabilities.'}
              </p>
            </div>

            {/* Activity Section */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[14px] font-semibold text-ink">Activity</h3>
                <button
                  type="button"
                  className="text-[12px] font-medium text-accent hover:underline cursor-pointer"
                >
                  View all
                </button>
              </div>

              {hasLiveTasks ? (
                <div className="space-y-1.5">
                  {tasks.map((task) => (
                    <div
                      key={task.id}
                      className="h-[36px] flex items-center justify-between gap-2.5 px-1 py-1 rounded-lg hover:bg-black/[0.02] transition-colors"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-6 h-6 rounded-md bg-sunken text-code flex items-center justify-center shrink-0">
                          <Compass size={13} strokeWidth={2} />
                        </div>
                        <span className="text-[13px] text-ink truncate">{task.title}</span>
                      </div>
                      <span className="text-[12px] text-faint shrink-0">
                        {Number.isNaN(Date.parse(task.timestamp))
                          ? task.timestamp
                          : new Date(task.timestamp).toLocaleTimeString([], {
                              hour: 'numeric',
                              minute: '2-digit',
                            })}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-4">
                  {defaultActivityGroups.map((group) => (
                    <div key={group.group} className="space-y-1.5">
                      <h4 className="text-[12px] font-medium text-muted">{group.group}</h4>
                      {group.items.map((item) => {
                        const Icon = item.icon;
                        return (
                          <div
                            key={item.id}
                            className="h-[36px] flex items-center justify-between gap-2.5 px-1 py-1 rounded-lg hover:bg-black/[0.02] transition-colors"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="w-6 h-6 rounded-md bg-sunken text-code flex items-center justify-center shrink-0">
                                <Icon size={13} strokeWidth={2} />
                              </div>
                              <span className="text-[13px] text-ink truncate">{item.title}</span>
                            </div>
                            <span className="text-[12px] text-faint shrink-0">{item.time}</span>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Skills Tab (Approvals & Permissions) */}
        {activeTab === 'security' && (
          <div className="space-y-3.5 pt-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted px-1">
              Approvals & Skills
            </span>
            {error && <Notice error>{error}</Notice>}
            {approvals.length === 0 && <Notice>No pending tool approvals.</Notice>}
            {approvals.map((approval) => (
              <div
                key={approval.id}
                className="p-4 bg-surface border border-hair rounded-2xl space-y-3 text-xs md:text-sm shadow-xs"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-ink uppercase text-xs px-2.5 py-1 rounded-lg bg-code-soft">
                    {approval.type}
                  </span>
                  <span
                    className={`text-xs font-medium capitalize ${
                      approval.status === 'pending'
                        ? 'text-amber-600'
                        : approval.status === 'approved'
                        ? 'text-emerald-600'
                        : 'text-red-600'
                    }`}
                  >
                    {approval.status}
                  </span>
                </div>
                <p className="text-code text-xs md:text-sm leading-relaxed">{approval.description}</p>
                {approval.commandSnippet && (
                  <pre className="p-3 bg-code-soft rounded-xl text-xs text-ink overflow-x-auto border border-hair font-mono select-text">
                    {approval.commandSnippet}
                  </pre>
                )}
                {approval.status === 'pending' && (
                  <div className="flex space-x-2 pt-1">
                    <button
                      disabled={approvalBusy !== null}
                      onClick={() => decide(approval.id, 'approved')}
                      className="flex-1 py-2 px-3 rounded-xl bg-accent hover:bg-accent-strong text-white font-medium text-xs md:text-sm flex items-center justify-center space-x-1.5 cursor-pointer disabled:opacity-40 transition-colors shadow-xs"
                    >
                      <Check size={14} />
                      <span>Approve</span>
                    </button>
                    <button
                      disabled={approvalBusy !== null}
                      onClick={() => decide(approval.id, 'rejected')}
                      className="flex-1 py-2 px-3 rounded-xl bg-neutral hover:bg-neutral-strong text-ink font-medium text-xs md:text-sm cursor-pointer disabled:opacity-40 transition-colors"
                    >
                      Deny
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Web Tab (Browser) */}
        {activeTab === 'browser' && <BrowserPanel />}

        {/* Files Tab (Identity / SOUL.md / MEMORY.md) */}
        {activeTab === 'identity' && <IdentityPanel />}

        {/* Settings Tab (Daily Goals & Scheduling) */}
        {activeTab === 'goals' && <DailyGoals />}
      </div>
      </div>

      {/* Mobile floating bottom dock navigation */}
      <div className="shrink-0 pt-1 pb-2 bg-transparent flex justify-center lg:hidden">
        <MobileDock
          currentMobileView="chat"
          onNavigateBots={() => toggleRightPanel()}
          onOpenActivity={() => toggleRightPanel()}
        />
      </div>
    </div>
  );
}

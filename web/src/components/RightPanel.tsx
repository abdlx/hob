import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
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
  List,
  ShieldCheck,
  Monitor,
  History,
  Fingerprint,
  Command,
  LoaderCircle,
  Share,
  Maximize2,
} from 'lucide-react';
import { useChat } from '../context/ChatContext';
import { useRuntime } from '../context/RuntimeContext';
import { apiFetch } from '../services/api';
import { activityOriginLabel } from '../services/activity';
import { AgentAvatar } from './AgentAvatar';
import { MarkdownView } from './MarkdownView';
import { DailyGoals } from '../pages/WorkspaceViews';
import { HermesBrowser, HermesIdentity } from '../pages/HermesWorkspace';
import { buttonClass, Field, inputClass, Notice, Skeleton, StatusPill } from './WorkspaceUI';
import { errorText } from './workspaceUtils';
import { useToast } from '../context/ToastContext';
import type { RightPanelTab } from '../types/chat';

const AgentComputerViewer = lazy(() => import('./AgentComputerViewer').then(module => ({ default: module.AgentComputerViewer })));

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

const RIGHT_PANEL_TABS = [
  { id: 'tasks', label: 'Activity', icon: List },
  { id: 'security', label: 'Approvals', icon: ShieldCheck },
  { id: 'browser', label: 'Browser', icon: Monitor },
  { id: 'goals', label: 'Scheduled tasks', icon: History },
  { id: 'identity', label: 'Identity', icon: Fingerprint },
] as const;

function LiveBrowserPanel() {
  const { agent } = useChat();
  const runtime = useRuntime();
  const [view, setView] = useState<'browser' | 'computer'>('browser');
  if (!agent) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-[4.2rem] w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  return runtime === 'hermes' ? <div className="space-y-4">
    <div className="hob-segments" role="tablist" aria-label="Computer views"><button role="tab" aria-selected={view === 'browser'} onClick={() => setView('browser')}>Browser session</button><button role="tab" aria-selected={view === 'computer'} onClick={() => setView('computer')}>Computer</button></div>
    {view === 'browser' ? <HermesBrowser key={agent.id} profile={agent.id} /> : <Suspense fallback={<Skeleton className="h-64 w-full" />}><AgentComputerViewer key={agent.id} profile={agent.id} /></Suspense>}
  </div> : <OpenClawBrowserPanel />;
}

function IdentityPanel() {
  const { agent } = useChat();
  const runtime = useRuntime();
  if (!agent) return <div className="space-y-3"><Skeleton className="h-9 w-full" /><Skeleton className="h-40 w-full" /></div>;
  return runtime === 'hermes' ? <HermesIdentity key={agent.id} profile={agent.id} /> : <OpenClawIdentityPanel />;
}

function BrowserPanel() {
  const [open, setOpen] = useState(false);
  return open ? <div className="space-y-4"><button className={buttonClass} onClick={() => setOpen(false)}><ArrowLeft size={16} />Back to preview</button><LiveBrowserPanel /></div> :
    <button type="button" className="hob-browser-preview" onClick={() => setOpen(true)} aria-label="Open browser">
      <div className="hob-browser-art" aria-hidden="true"><div className="hob-browser-window"><div className="hob-browser-traffic"><i /><i /><i /></div><div className="hob-browser-mini-avatar"><Monitor size={22} /></div><div className="hob-browser-address" /></div></div>
      <span>Open browser <Maximize2 size={16} /></span>
    </button>;
}

export function RightPanel() {
  const { agent, connected, tasks, activityWarnings, approvals, activeTab, setActiveTab, isRightPanelOpen, toggleRightPanel, resolveApproval } = useChat();
  const [error, setError] = useState('');
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const { toast } = useToast();
  const share = async () => {
    try { if (navigator.share) await navigator.share({ title: 'hob', url: window.location.origin }); else { await navigator.clipboard.writeText(window.location.origin); toast('Link copied.'); } }
    catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) toast('Could not share the link.', 'error'); }
  };
  if (!isRightPanelOpen) return null;
  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    setApprovalBusy(id); setError('');
    try { await resolveApproval(id, decision); } catch (error) { setError(errorText(error)); } finally { setApprovalBusy(null); }
  };
  const groups = new Map<string, typeof tasks>();
  for (const task of tasks) {
    const parsed = new Date(task.timestamp);
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const label = task.group || (Number.isNaN(parsed.getTime()) || parsed.toDateString() === new Date().toDateString() ? 'Today' : parsed.toDateString() === yesterday.toDateString() ? 'Yesterday' : parsed.toLocaleDateString([], { month: 'long', day: 'numeric' }));
    groups.set(label, [...(groups.get(label) || []), task]);
  }
  return <div className="hob-agent-panel">
    <div className="hob-agent-scroll">
      <header className="hob-agent-profile">
        <button className="hob-round-button hob-agent-close" aria-label="Back to chat" title="Close panel" onClick={toggleRightPanel}><X size={24} strokeWidth={1.6} /></button>
        <AgentAvatar size={72} showEditBadge avatarUrl={agent?.avatarUrl} onEditClick={() => setActiveTab('identity')} hideBorder hideStatusDot />
        <button className="hob-round-button hob-agent-config" aria-label="Share app" onClick={() => void share()}><Share size={23} strokeWidth={1.6} /></button>
        <h2>{agent?.name || 'Main'}</h2>
        <p>{connected ? 'online' : 'offline'}</p>
      </header>
      <div className="hob-segments hob-agent-tabs" role="tablist" aria-label="Agent panel">
        {RIGHT_PANEL_TABS.map(({ id, label, icon: Icon }) => <button key={id} role="tab" id={`agent-tab-${id}`} aria-selected={activeTab === id} aria-controls="agent-tab-content" aria-label={label} title={label} onClick={() => setActiveTab(id as RightPanelTab)}><Icon size={22} strokeWidth={1.65} /></button>)}
      </div>
      <div className="hob-agent-content" id="agent-tab-content" role="tabpanel" aria-labelledby={`agent-tab-${activeTab}`}>
        {activeTab === 'tasks' && <div className="hob-activity-list">
          {activityWarnings.length > 0 && <Notice>{activityWarnings.join(' ')}</Notice>}
          {!tasks.length && <><h3>Today</h3><p className="hob-empty-copy">{activityWarnings.length ? 'Activity is incomplete. Try refreshing when task history is available.' : connected ? 'No activity yet. Tasks will appear here as your bot works.' : 'Activity is unavailable while your bot is offline.'}</p></>}
          {[...groups].map(([label, entries]) => <section key={label}><h3>{label}</h3>{entries.map(task => <div className="hob-detail-row" key={task.id}>
            <span className={`hob-task-icon ${task.status === 'in_progress' ? 'is-running' : ''}`}>{task.status === 'in_progress' ? <LoaderCircle size={18} className="animate-spin motion-reduce:animate-none" /> : <Command size={21} />}</span>
            <div><h4>{task.title}</h4>{task.subtitle && <p>{task.subtitle}</p>}{task.origin?.kind === 'scheduled-job' && <><StatusPill status={task.status} /><p>{activityOriginLabel(task)}</p></>}<time>{Number.isNaN(Date.parse(task.timestamp)) ? task.timestamp : new Date(task.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div>
          </div>)}</section>)}
        </div>}
        {activeTab === 'security' && <div className="hob-approvals-list"><h3>Approvals history</h3>{error && <Notice error>{error}</Notice>}{!approvals.length && <p className="hob-empty-copy">No approvals yet.</p>}
          {approvals.map(approval => <div key={approval.id} className="hob-detail-row"><span className="hob-approval-icon"><Globe size={31} strokeWidth={1.8} /></span><div><h4>{approval.description}</h4><p>{approval.type}</p><time>{approval.status === 'pending' ? 'Awaiting approval' : approval.status === 'approved' ? 'Allowed' : 'Denied'} ? {new Date(approval.requestedAt).toLocaleDateString()}</time>
            {approval.commandSnippet && <pre className="hob-approval-command">{approval.commandSnippet}</pre>}
            {approval.status === 'pending' && <div className="mt-3 flex gap-2"><button className={buttonClass} disabled={approvalBusy !== null} onClick={() => void decide(approval.id, 'approved')}><Check size={15} />Approve</button><button className={buttonClass} disabled={approvalBusy !== null} onClick={() => void decide(approval.id, 'rejected')}>Deny</button></div>}
          </div></div>)}
        </div>}
        {activeTab === 'browser' && <BrowserPanel />}
        {activeTab === 'goals' && <div className="hob-scheduled-tasks"><DailyGoals /></div>}
        {activeTab === 'identity' && <IdentityPanel />}
      </div>
    </div>
  </div>;
}

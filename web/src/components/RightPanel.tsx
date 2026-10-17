import { useCallback, useEffect, useRef, useState } from 'react';
import { List, Shield, Globe, SquareCheck, Fingerprint, CheckCircle2, FileText, X, Check, RefreshCw, Plus, Camera, Save, ArrowLeft } from 'lucide-react';
import { useChat } from '../context/ChatContext';
import { useRuntime } from '../context/RuntimeContext';
import { apiFetch } from '../services/api';
import { DogeshAvatar } from './DogeshAvatar';
import { MarkdownView } from './MarkdownView';
import { DailyGoals } from '../pages/WorkspaceViews';
import { HermesBrowser, HermesIdentity } from '../pages/HermesWorkspace';
import { buttonClass, Field, inputClass, Notice } from './WorkspaceUI';
import { errorText } from './workspaceUtils';

interface BrowserTab { targetId: string; title?: string; url?: string; type?: string }
function OpenClawBrowserPanel() {
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [selected, setSelected] = useState('');
  const [url, setUrl] = useState('');
  const [snapshot, setSnapshot] = useState('');
  const [screenshot, setScreenshot] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => { try { const data = await apiFetch<{ tabs: BrowserTab[] }>('/api/browser/tabs'); setTabs(data.tabs || []); setError(''); } catch (error) { setError(errorText(error)); } finally { setLoading(false); } }, []);
  useEffect(() => { const initial = window.setTimeout(load, 0); return () => window.clearTimeout(initial); }, [load]);
  const action = async (action: string, targetId = selected) => {
    if ((action === 'navigate' || action === 'open') && !/^https?:\/\//i.test(url.trim())) { setError('Enter a full http:// or https:// address.'); return; }
    setBusy(true); setError('');
    try {
      const data = await apiFetch<{ snapshot?: string; text?: string; targetId?: string; imageUrl?: string; dataUrl?: string; url?: string; base64?: string; mimeType?: string }>('/api/browser/actions', { method: 'POST', body: JSON.stringify({ action, targetId: targetId || undefined, url: action === 'open' || action === 'navigate' ? url.trim() : undefined }) });
      if (action === 'snapshot') { setSnapshot(data.snapshot || data.text || JSON.stringify(data, null, 2)); setScreenshot(''); }
      if (action === 'screenshot') { setScreenshot(data.imageUrl || data.dataUrl || (data.base64 ? `data:${data.mimeType || 'image/png'};base64,${data.base64}` : data.url || '')); if (!data.imageUrl && !data.dataUrl && !data.base64 && !data.url) setSnapshot(JSON.stringify(data, null, 2)); }
      if (data.targetId) setSelected(data.targetId);
      if (action === 'close' && targetId === selected) { setSelected(''); setSnapshot(''); setScreenshot(''); }
      await load();
    } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  };
  return <div className="space-y-3.5 pt-2">
    <div className="flex items-center justify-between">
      <span className="text-xs font-semibold uppercase tracking-wider text-[#9d907e]">OpenClaw browser</span>
      <button disabled={busy} title="Refresh browser tabs" onClick={load} className="text-[#a59784] hover:text-[#faeee1] transition-colors p-1"><RefreshCw size={15} /></button>
    </div>
    {error && <Notice error>{error}</Notice>}
    <div className="flex gap-2">
      <button disabled={busy} className={buttonClass} onClick={() => action('start')}>Start browser</button>
      <button disabled={busy || !url.trim()} className={buttonClass} onClick={() => action('open')}><Plus size={14} />Tab</button>
    </div>
    <Field label="Address">
      <input className={inputClass} placeholder="https://example.com" value={url} onChange={(event) => setUrl(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !busy) void action(selected ? 'navigate' : 'open'); }} />
    </Field>
    <button disabled={busy || !selected || !url.trim()} className={buttonClass} onClick={() => action('navigate')}>Navigate selected tab</button>
    {loading ? <Notice>Loading browser tabs…</Notice> : tabs.length === 0 ? <Notice>No open tabs. Start the browser and open an address.</Notice> : tabs.map((tab) => <div key={tab.targetId} className={`flex gap-2 rounded-xl border p-3 transition-colors ${selected === tab.targetId ? 'border-[#8f6d48] bg-[#221a14]' : 'border-[#2d251d] bg-[#16120e]'}`}><button className="flex-1 min-w-0 text-left cursor-pointer" onClick={() => { setSelected(tab.targetId); setUrl(tab.url || ''); setSnapshot(''); setScreenshot(''); }}><p className="text-xs md:text-sm font-medium text-[#ded4c6] truncate">{tab.title || 'Untitled tab'}</p><p className="text-xs text-[#8c806f] truncate mt-0.5">{tab.url || tab.targetId}</p></button><button title="Close browser tab" disabled={busy} onClick={() => action('close', tab.targetId)} className="text-[#968977] hover:text-white p-1"><X size={15} /></button></div>)}
    <div className="flex gap-2">
      <button className={buttonClass} disabled={busy || !selected} onClick={() => action('snapshot')}><FileText size={14} />Snapshot</button>
      <button aria-label="Capture browser screenshot" title="Capture browser screenshot" className={buttonClass} disabled={busy || !selected} onClick={() => action('screenshot')}><Camera size={14} /></button>
    </div>
    {busy && <Notice>Waiting for the browser…</Notice>}
    {screenshot && <img src={screenshot} alt="Current agent browser screenshot" className="w-full rounded-2xl border border-[#332a20]" />}
    {snapshot && <pre className="select-text whitespace-pre-wrap break-words max-h-[400px] overflow-auto text-xs leading-relaxed text-[#c0b3a1] p-3.5 bg-[#0e0c0a] rounded-xl border border-[#28211a] font-mono">{snapshot}</pre>}
  </div>;
}

interface AgentFile { agentId: string; workspace: string; file: { name: string; content: string; hash?: string; missing?: boolean } }
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
  useEffect(() => () => { fileRequest.current++; }, []);
  const agentId = agent?.id || 'main';
  const filePath = (fileName: string) => `/api/agent/files/${encodeURIComponent(fileName)}?agentId=${encodeURIComponent(agentId)}`;
  const open = async (fileName: string) => {
    const request = ++fileRequest.current;
    setSelected(fileName); setFile(null); setDraft(''); setEditing(false); setError(''); setStatus(''); setBusy(true);
    try {
      const result = await apiFetch<AgentFile>(filePath(fileName));
      if (request !== fileRequest.current) return;
      if (result.file.name !== fileName || result.agentId !== agentId) throw new Error('The gateway returned a different agent file. Please reopen the file.');
      setFile(result); setDraft(result.file.content || '');
    } catch (error) { if (request === fileRequest.current) setError(errorText(error)); }
    finally { if (request === fileRequest.current) setBusy(false); }
  };
  const saveFile = async () => {
    if (!file || !selected || selected !== file.file.name || file.agentId !== agentId) return;
    const request = fileRequest.current;
    const target = file.file.name;
    setBusy(true); setError('');
    try {
      await apiFetch(filePath(target), { method: 'PUT', body: JSON.stringify({ content: draft, ...(file.file.missing ? { expectedMissing: true } : { expectedHash: file.file.hash }), agentId: file.agentId }) });
      if (request !== fileRequest.current) return;
      await open(target);
      if (fileRequest.current === request + 1) setStatus('File saved to the agent workspace.');
    } catch (error) { if (request === fileRequest.current) setError(errorText(error)); }
    finally { if (request === fileRequest.current) setBusy(false); }
  };
  const saveIdentity = async () => {
    if (!name.trim()) { setError('Enter an agent name.'); return; }
    setBusy(true); setError('');
    try {
      await updateAgent({ id: agentId, name: name.trim(), ...(avatarUrl !== (agent?.avatarUrl || '') ? { avatarUrl } : {}), ...(model.trim() && model.trim() !== agent?.model ? { model: model.trim() } : {}) });
      setIdentityEditing(false); setStatus('Identity saved.');
    } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  };
  return <div className="space-y-3.5 pt-2">
    {error && <Notice error>{error}</Notice>}
    {status && <Notice>{status}</Notice>}
    {selected ? <>
      <div className="flex items-center justify-between gap-2">
        <button className={buttonClass} onClick={() => { fileRequest.current++; setSelected(null); setFile(null); setDraft(''); setEditing(false); setStatus(''); setBusy(false); }}>
          <ArrowLeft size={14} /> Back
        </button>
        <span className="text-sm font-semibold text-[#dec9ad] font-mono">{selected}</span>
        {editing ? <button disabled={busy} className={buttonClass} onClick={saveFile}><Save size={14} />Save</button> : <button disabled={busy || !file} className={buttonClass} onClick={() => setEditing(true)}>Edit</button>}
      </div>
      {busy ? <Notice>Loading agent file…</Notice> : file && (editing ? <>
        <textarea aria-label={`Edit ${selected}`} className={`${inputClass} font-mono min-h-[340px] text-xs md:text-sm leading-relaxed`} value={draft} onChange={(event) => setDraft(event.target.value)} />
        <button className={buttonClass} onClick={() => { setDraft(file.file.content || ''); setEditing(false); }}>Cancel</button>
      </> : file.file.missing ? <Notice>{selected} has not been created yet. Click Edit to create it.</Notice> : <div className="p-3.5 bg-[#14110e] border border-[#2d251d] rounded-2xl"><MarkdownView content={file.file.content} /></div>)}
    </> : <>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-[#9d907e]">Agent identity</span>
        <button className={buttonClass} onClick={() => { setName(agent?.name || ''); setAvatarUrl(agent?.avatarUrl || ''); setModel(agent?.model || ''); setIdentityEditing(true); }}>
          <Plus size={14} />{agent?.name ? 'Edit identity' : 'Add identity'}
        </button>
      </div>
      {identityEditing && <div className="space-y-3.5 rounded-2xl p-4 border border-[#332a20] bg-[#16120e]">
        <Field label="Name"><input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="Avatar URL"><input className={inputClass} placeholder="https://…" value={avatarUrl} onChange={(event) => setAvatarUrl(event.target.value)} /></Field>
        <Field label="Model"><input className={inputClass} value={model} onChange={(event) => setModel(event.target.value)} placeholder="provider/model" /></Field>
        <div className="flex gap-2">
          <button disabled={busy} className={buttonClass} onClick={saveIdentity}>Save identity</button>
          <button className={buttonClass} onClick={() => setIdentityEditing(false)}>Cancel</button>
        </div>
      </div>}
      {agent?.roleDescription && <p className="text-xs md:text-sm text-[#9b8f7e] px-1 leading-relaxed">{agent.roleDescription}</p>}
      {[{ name: 'SOUL.md', title: 'Soul', description: 'Personality, values, and behavior' }, { name: 'MEMORY.md', title: 'Memory', description: 'Long-term memory and context' }].map((item) => (
        <button key={item.name} onClick={() => open(item.name)} className="w-full rounded-2xl border border-[#2e261e] bg-[#15120f] text-left p-4 hover:border-[#7b5f3f] hover:bg-[#1c1712] transition-all cursor-pointer space-y-1">
          <FileText size={20} className="text-[#c99f6f] mb-2" />
          <p className="text-sm font-semibold text-[#eee1d1]">{item.title}</p>
          <p className="text-xs text-[#9c8e7c] mt-0.5 leading-relaxed">{item.description}</p>
          <p className="text-xs text-[#756856] mt-1 font-mono">{item.name}</p>
        </button>
      ))}
    </>}
  </div>;
}

function BrowserPanel() {
  const { agent } = useChat();
  const runtime = useRuntime();
  if (!agent) return <Notice>Loading browser…</Notice>;
  return runtime === 'hermes' ? <HermesBrowser key={agent.id} profile={agent.id} /> : <OpenClawBrowserPanel />;
}

function IdentityPanel() {
  const { agent } = useChat();
  const runtime = useRuntime();
  if (!agent) return <Notice>Loading identity…</Notice>;
  return runtime === 'hermes' ? <HermesIdentity key={agent.id} profile={agent.id} /> : <OpenClawIdentityPanel />;
}

export function RightPanel() {
  const { agent, connected, tasks, approvals, activeTab, setActiveTab, isRightPanelOpen, toggleRightPanel, resolveApproval } = useChat();
  const [error, setError] = useState('');
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  if (!isRightPanelOpen) return null;
  const tabs = [
    { id: 'tasks', title: 'Activity', icon: List },
    { id: 'security', title: 'Approvals', icon: Shield },
    { id: 'browser', title: 'Browser', icon: Globe },
    { id: 'goals', title: 'Daily goals', icon: SquareCheck },
    { id: 'identity', title: 'Agent identity', icon: Fingerprint }
  ] as const;
  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    setApprovalBusy(id); setError('');
    try { await resolveApproval(id, decision); }
    catch (error) { setError(errorText(error)); }
    finally { setApprovalBusy(null); }
  };
  return (
    <aside className="hob-agent-panel w-[350px] 2xl:w-[380px] max-w-[90vw] bg-[#14110e] border-l border-[#27211a] flex flex-col h-full shrink-0 select-none overflow-hidden relative max-md:fixed max-md:right-0 max-md:top-0 max-md:z-30 max-md:shadow-2xl">
      {/* Close button */}
      <button onClick={toggleRightPanel} title="Close panel" className="absolute top-4 right-4 p-2 rounded-xl text-[#a89b8b] hover:text-white hover:bg-[#251f18] transition-colors cursor-pointer z-10">
        <X size={17} strokeWidth={2} />
      </button>

      {/* Profile Header */}
      <div className="pt-6 pb-4 px-5 flex flex-col items-center border-b border-[#241e18]">
        <DogeshAvatar size={76} showEditBadge avatarUrl={agent?.avatarUrl || '/brand/hob-mark.png'} onEditClick={() => setActiveTab('identity')} />
        <h2 className="mt-2.5 text-base md:text-lg font-semibold text-[#f8ede3] tracking-tight">{agent?.name || 'Your agent'}</h2>
        <div className="flex items-center space-x-2 mt-1">
          <span className={`w-2 h-2 rounded-full inline-block ${connected && agent?.status === 'connected' ? 'bg-[#22c55e] shadow-[0_0_8px_rgba(34,197,94,0.6)]' : agent?.status === 'busy' ? 'bg-amber-400' : 'bg-[#68645e]'}`} />
          <span className="text-xs font-medium text-[#9a9184] capitalize">{connected ? agent?.status || 'Connected' : 'Disconnected'}</span>
        </div>

        {/* Tab switcher */}
        <div className="w-full mt-4 bg-[#100e0c] border border-[#29221b] rounded-2xl p-1 flex items-center justify-between" role="tablist" aria-label="Agent panel">
          {tabs.map(({ id, title, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={activeTab === id}
              aria-label={title}
              onClick={() => setActiveTab(id)}
              title={title}
              className={`flex-1 py-2 rounded-xl flex items-center justify-center transition-all cursor-pointer ${
                activeTab === id
                  ? 'bg-[#271f17] text-[#ff9e63] shadow-xs border border-[#483726]'
                  : 'text-[#9c9081] hover:text-[#faeee1] hover:bg-[#1a1511] border border-transparent'
              }`}
            >
              <Icon size={16} strokeWidth={1.8} />
            </button>
          ))}
        </div>
      </div>

      {/* Tab Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {activeTab === 'tasks' && (
          <div>
            <div className="px-1 mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-[#9d907e]">Activity</span>
            </div>
            {tasks.length === 0 && <Notice>Agent activity appears here as you work.</Notice>}
            <div className="space-y-1.5">
              {tasks.map((task) => (
                <div key={task.id} className="p-3 rounded-2xl hover:bg-[#1c1712] border border-transparent hover:border-[#2d251d] transition-all flex items-start space-x-3 group">
                  <div className="w-8 h-8 rounded-xl bg-[#201a14] border border-[#332a20] flex items-center justify-center shrink-0 mt-0.5 text-[#e5c9a9]">
                    {task.status === 'completed' ? <CheckCircle2 size={16} strokeWidth={1.8} /> : <FileText size={16} strokeWidth={1.8} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-1.5">
                      <h4 className="text-xs md:text-sm font-medium leading-[1.35] text-[#eee7dc] line-clamp-2">{task.title}</h4>
                      <span className="text-xs text-[#7e7467] shrink-0 self-start mt-0.5">
                        {Number.isNaN(Date.parse(task.timestamp)) ? task.timestamp : new Date(task.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    {task.subtitle && <p className="text-xs text-[#9d9283] mt-1 leading-[1.3] line-clamp-2">{task.subtitle}</p>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'security' && (
          <div className="space-y-3.5 pt-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-[#9d907e] px-1">Approvals</span>
            {error && <Notice error>{error}</Notice>}
            {approvals.length === 0 && <Notice>No pending tool approvals.</Notice>}
            {approvals.map((approval) => (
              <div key={approval.id} className="p-4 bg-[#171310] border border-[#2b241c] rounded-2xl space-y-3 text-xs md:text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-[#f0e4d4] uppercase text-xs px-2.5 py-1 rounded-lg bg-[#241c14] border border-[#3d2e1f]">{approval.type}</span>
                  <span className={`text-xs font-medium capitalize ${approval.status === 'pending' ? 'text-amber-400' : approval.status === 'approved' ? 'text-emerald-400' : 'text-red-400'}`}>{approval.status}</span>
                </div>
                <p className="text-[#ded5c8] text-xs md:text-sm leading-relaxed">{approval.description}</p>
                {approval.commandSnippet && (
                  <pre className="p-3 bg-[#0d0b09] rounded-xl text-xs text-amber-200 overflow-x-auto border border-[#2c231b] font-mono select-text">{approval.commandSnippet}</pre>
                )}
                {approval.status === 'pending' && (
                  <div className="flex space-x-2 pt-1">
                    <button disabled={approvalBusy !== null} onClick={() => decide(approval.id, 'approved')} className="flex-1 py-2 px-3 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-medium text-xs md:text-sm flex items-center justify-center space-x-1.5 cursor-pointer disabled:opacity-40 transition-colors shadow-xs">
                      <Check size={14} /><span>Approve</span>
                    </button>
                    <button disabled={approvalBusy !== null} onClick={() => decide(approval.id, 'rejected')} className="flex-1 py-2 px-3 rounded-xl bg-[#262019] hover:bg-[#332b21] text-[#e0d6c8] font-medium text-xs md:text-sm cursor-pointer disabled:opacity-40 transition-colors border border-[#382d21]">
                      Deny
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {activeTab === 'browser' && <BrowserPanel />}
        {activeTab === 'goals' && <DailyGoals />}
        {activeTab === 'identity' && <IdentityPanel />}
      </div>
    </aside>
  );
}


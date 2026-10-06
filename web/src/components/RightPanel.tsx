import { useCallback, useEffect, useRef, useState } from 'react';
import { List, Shield, Globe, SquareCheck, Fingerprint, CheckCircle2, FileText, X, Check, RefreshCw, Plus, Camera, Save, ArrowLeft } from 'lucide-react';
import { useChat } from '../context/ChatContext';
import { apiFetch } from '../services/api';
import { DogeshAvatar } from './DogeshAvatar';
import { MarkdownView } from './MarkdownView';
import { DailyGoals } from '../pages/WorkspaceViews';
import { buttonClass, Field, inputClass, Notice } from './WorkspaceUI';
import { errorText } from './workspaceUtils';

interface BrowserTab { targetId: string; title?: string; url?: string; type?: string }
function BrowserPanel() {
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
  return <div className="space-y-3 pt-2"><div className="flex items-center justify-between"><span className="text-xs text-[#a29889]">OpenClaw browser</span><button disabled={busy} title="Refresh browser tabs" onClick={load}><RefreshCw size={13} /></button></div>{error && <Notice error>{error}</Notice>}<div className="flex gap-2"><button disabled={busy} className={buttonClass} onClick={() => action('start')}>Start browser</button><button disabled={busy || !url.trim()} className={buttonClass} onClick={() => action('open')}><Plus size={12} />Tab</button></div><Field label="Address"><input className={inputClass} placeholder="https://example.com" value={url} onChange={(event) => setUrl(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !busy) void action(selected ? 'navigate' : 'open'); }} /></Field><button disabled={busy || !selected || !url.trim()} className={buttonClass} onClick={() => action('navigate')}>Navigate selected tab</button>{loading ? <Notice>Loading browser tabs…</Notice> : tabs.length === 0 ? <Notice>No open tabs. Start the browser and open an address.</Notice> : tabs.map((tab) => <div key={tab.targetId} className={`flex gap-1 rounded-xl border p-2 ${selected === tab.targetId ? 'border-[#735b3d] bg-[#1e1812]' : 'border-[#24211c]'}`}><button className="flex-1 min-w-0 text-left cursor-pointer" onClick={() => { setSelected(tab.targetId); setUrl(tab.url || ''); setSnapshot(''); setScreenshot(''); }}><p className="text-[11px] text-[#d3c8b8] truncate">{tab.title || 'Untitled tab'}</p><p className="text-[9px] text-[#827869] truncate">{tab.url || tab.targetId}</p></button><button title="Close browser tab" disabled={busy} onClick={() => action('close', tab.targetId)}><X size={12} /></button></div>)}<div className="flex gap-2"><button className={buttonClass} disabled={busy || !selected} onClick={() => action('snapshot')}><FileText size={12} />Snapshot</button><button aria-label="Capture browser screenshot" title="Capture browser screenshot" className={buttonClass} disabled={busy || !selected} onClick={() => action('screenshot')}><Camera size={12} /></button></div>{busy && <Notice>Waiting for the browser…</Notice>}{screenshot && <img src={screenshot} alt="Current agent browser screenshot" className="w-full rounded-xl border border-[#2b251e]" />}{snapshot && <pre className="select-text whitespace-pre-wrap break-words max-h-[400px] overflow-auto text-[10px] text-[#a99d8b] p-2 bg-[#101010] rounded-xl">{snapshot}</pre>}</div>;
}

interface AgentFile { agentId: string; workspace: string; file: { name: string; content: string; hash?: string; missing?: boolean } }
function IdentityPanel() {
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
  const saveIdentity = async () => { if (!name.trim()) { setError('Enter an agent name.'); return; } setBusy(true); setError(''); try { await updateAgent({ id: agentId, name: name.trim(), ...(avatarUrl !== (agent?.avatarUrl || '') ? { avatarUrl } : {}), ...(model.trim() && model.trim() !== agent?.model ? { model: model.trim() } : {}) }); setIdentityEditing(false); setStatus('Identity saved.'); } catch (error) { setError(errorText(error)); } finally { setBusy(false); } };
  return <div className="space-y-3 pt-2">{error && <Notice error>{error}</Notice>}{status && <Notice>{status}</Notice>}{selected ? <><div className="flex items-center justify-between gap-1"><button className={buttonClass} onClick={() => { fileRequest.current++; setSelected(null); setFile(null); setDraft(''); setEditing(false); setStatus(''); setBusy(false); }}><ArrowLeft size={11} /></button><span className="text-[12px] text-[#c9b69b]">{selected}</span>{editing ? <button disabled={busy} className={buttonClass} onClick={saveFile}><Save size={11} />Save</button> : <button disabled={busy || !file} className={buttonClass} onClick={() => setEditing(true)}>Edit</button>}</div>{busy ? <Notice>Loading agent file…</Notice> : file && (editing ? <><textarea aria-label={`Edit ${selected}`} className={`${inputClass} font-mono min-h-[320px]`} value={draft} onChange={(event) => setDraft(event.target.value)} /><button className={buttonClass} onClick={() => { setDraft(file.file.content || ''); setEditing(false); }}>Cancel</button></> : file.file.missing ? <Notice>{selected} has not been created yet. Click Edit to create it.</Notice> : <MarkdownView content={file.file.content} />)}</> : <><div className="flex items-center justify-between"><span className="text-xs text-[#a39888]">Agent identity</span><button className={buttonClass} onClick={() => { setName(agent?.name || ''); setAvatarUrl(agent?.avatarUrl || ''); setModel(agent?.model || ''); setIdentityEditing(true); }}><Plus size={11} />{agent?.name ? 'Edit identity' : 'Add identity'}</button></div>{identityEditing && <div className="space-y-3 rounded-xl p-3 border border-[#29231b]"><Field label="Name"><input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="Avatar URL"><input className={inputClass} placeholder="https://…" value={avatarUrl} onChange={(event) => setAvatarUrl(event.target.value)} /></Field><Field label="Model"><input className={inputClass} value={model} onChange={(event) => setModel(event.target.value)} placeholder="provider/model" /></Field><div className="flex gap-2"><button disabled={busy} className={buttonClass} onClick={saveIdentity}>Save identity</button><button className={buttonClass} onClick={() => setIdentityEditing(false)}>Cancel</button></div></div>}{agent?.roleDescription && <p className="text-[11px] text-[#8d8374] px-1">{agent.roleDescription}</p>}{[{ name: 'SOUL.md', title: 'Soul', description: 'Personality, values, and behavior' }, { name: 'MEMORY.md', title: 'Memory', description: 'Long-term memory and context' }].map((item) => <button key={item.name} onClick={() => open(item.name)} className="w-full rounded-2xl border border-[#28231c] bg-[#11100e] text-left p-4 hover:border-[#766047] cursor-pointer"><FileText size={16} className="text-[#b79870] mb-2" /><p className="text-[12px] text-[#d8c8b0]">{item.title}</p><p className="text-[10px] text-[#817665] mt-1">{item.description}</p><p className="text-[9px] text-[#675e52] mt-1">{item.name}</p></button>)}</>}</div>;
}

export function RightPanel() {
  const { agent, connected, tasks, approvals, activeTab, setActiveTab, isRightPanelOpen, toggleRightPanel, resolveApproval } = useChat();
  const [error, setError] = useState('');
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  if (!isRightPanelOpen) return null;
  const tabs = [{ id: 'tasks', title: 'Activity', icon: List }, { id: 'security', title: 'Approvals', icon: Shield }, { id: 'browser', title: 'Browser', icon: Globe }, { id: 'goals', title: 'Daily goals', icon: SquareCheck }, { id: 'identity', title: 'Agent identity', icon: Fingerprint }] as const;
  const decide = async (id: string, decision: 'approved' | 'rejected') => { setApprovalBusy(id); setError(''); try { await resolveApproval(id, decision); } catch (error) { setError(errorText(error)); } finally { setApprovalBusy(null); } };
  return <aside className="w-[275px] max-w-[85vw] bg-black border-l border-[#181818] flex flex-col h-full shrink-0 select-none overflow-hidden relative max-md:fixed max-md:right-0 max-md:top-0 max-md:z-30 max-md:shadow-2xl"><button onClick={toggleRightPanel} title="Close panel" className="absolute top-3.5 right-3.5 p-1.5 rounded-full text-white hover:bg-[#181818] transition-colors cursor-pointer z-10"><X size={14} strokeWidth={2} /></button><div className="pt-5 pb-3 px-4 flex flex-col items-center"><DogeshAvatar size={64} showEditBadge avatarUrl={agent?.avatarUrl || '/dogesh.png'} onEditClick={() => setActiveTab('identity')} /><h2 className="mt-2 text-[14px] font-semibold text-white tracking-tight">{agent?.name || 'Your agent'}</h2><div className="flex items-center space-x-1.5 mt-0.5"><span className={`w-1.5 h-1.5 rounded-full inline-block ${connected && agent?.status === 'connected' ? 'bg-[#22c55e] shadow-[0_0_5px_rgba(34,197,94,0.7)]' : agent?.status === 'busy' ? 'bg-amber-400' : 'bg-[#68645e]'}`} /><span className="text-[11px] font-normal text-[#8a8883] capitalize">{connected ? agent?.status || 'Connected' : 'Disconnected'}</span></div><div className="w-full mt-3 bg-[#111111] border border-[#1f1f1f] rounded-full p-0.5 flex items-center justify-between" role="tablist" aria-label="Agent panel">{tabs.map(({ id, title, icon: Icon }) => <button key={id} role="tab" aria-selected={activeTab === id} aria-label={title} onClick={() => setActiveTab(id)} title={title} className={`flex-1 py-1.5 rounded-full flex items-center justify-center transition-colors cursor-pointer text-white ${activeTab === id ? 'bg-[#242424] shadow-xs' : 'hover:bg-[#1a1a1a]'}`}><Icon size={14} strokeWidth={1.8} /></button>)}</div></div><div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1">{activeTab === 'tasks' && <div><div className="px-1 mb-1 mt-0.5"><span className="text-[11px] font-medium text-[#73716c]">Activity</span></div>{tasks.length === 0 && <Notice>Agent activity appears here as you work.</Notice>}<div className="space-y-0.5">{tasks.map((task) => <div key={task.id} className="p-1.5 rounded-xl hover:bg-[#121212] transition-all flex items-start space-x-2 group"><div className="w-[22px] h-[22px] rounded-full bg-[#141414] border border-[#222222] flex items-center justify-center shrink-0 mt-0.5 text-white">{task.status === 'completed' ? <CheckCircle2 size={12} strokeWidth={1.8} /> : <FileText size={12} strokeWidth={1.8} />}</div><div className="flex-1 min-w-0 pr-0.5"><div className="flex items-start justify-between gap-1"><h4 className="text-[11px] font-medium leading-[1.3] text-[#dedcd8] line-clamp-2">{task.title}</h4><span className="text-[9.5px] text-[#55534e] shrink-0 self-start mt-0.5">{Number.isNaN(Date.parse(task.timestamp)) ? task.timestamp : new Date(task.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>{task.subtitle && <p className="text-[10px] text-[#706e69] mt-0.5 leading-[1.25] line-clamp-2">{task.subtitle}</p>}</div></div>)}</div></div>}{activeTab === 'security' && <div className="space-y-3 pt-2"><span className="text-xs font-semibold text-[#888888] px-1">Approvals</span>{error && <Notice error>{error}</Notice>}{approvals.length === 0 && <Notice>No pending tool approvals.</Notice>}{approvals.map((approval) => <div key={approval.id} className="p-3 bg-[#111111] border border-[#1f1f1f] rounded-2xl space-y-2 text-xs"><div className="flex items-center justify-between"><span className="font-semibold text-neutral-200 uppercase text-[10px] px-2 py-0.5 rounded-full bg-[#181818] border border-[#262626]">{approval.type}</span><span className={`text-[10px] ${approval.status === 'pending' ? 'text-amber-400' : approval.status === 'approved' ? 'text-emerald-400' : 'text-red-400'}`}>{approval.status}</span></div><p className="text-neutral-300 text-[11px] leading-tight">{approval.description}</p>{approval.commandSnippet && <pre className="p-2 bg-black rounded-xl text-[10px] text-amber-200 overflow-x-auto border border-[#222222] font-mono select-text">{approval.commandSnippet}</pre>}{approval.status === 'pending' && <div className="flex space-x-2 pt-1"><button disabled={approvalBusy !== null} onClick={() => decide(approval.id, 'approved')} className="flex-1 py-1 px-2 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-[11px] flex items-center justify-center space-x-1 cursor-pointer disabled:opacity-40"><Check size={12} /><span>Approve</span></button><button disabled={approvalBusy !== null} onClick={() => decide(approval.id, 'rejected')} className="flex-1 py-1 px-2 rounded-full bg-[#242424] hover:bg-[#2e2e2e] text-neutral-300 text-[11px] cursor-pointer disabled:opacity-40">Deny</button></div>}</div>)}</div>}{activeTab === 'browser' && <BrowserPanel />}{activeTab === 'goals' && <DailyGoals />}{activeTab === 'identity' && <IdentityPanel />}</div></aside>;
}

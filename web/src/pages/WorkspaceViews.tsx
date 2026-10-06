import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, FileText, Image, Play, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { apiFetch } from '../services/api';
import { arrayReplacementPaths } from '../services/config';
import { useChat } from '../context/ChatContext';
import { MarkdownView } from '../components/MarkdownView';
import { buttonClass, cardClass, Field, inputClass, Notice } from '../components/WorkspaceUI';
import { errorText } from '../components/workspaceUtils';
import { SettingsActions } from '../components/SettingsActions';
import { CredentialsSettings } from '../components/CredentialsSettings';
import { SetupWizard } from '../components/SetupWizard';

export interface GoalJob {
  id: string; name: string; enabled: boolean; configRevision?: string;
  schedule: { kind: string; at?: string; everyMs?: number; expr?: string; tz?: string };
  payload: { kind: string; message?: string; text?: string; [key: string]: unknown };
  state?: { nextRunAtMs?: number; lastRunAtMs?: number; lastRunStatus?: string; lastError?: string };
}

function jsonInit(method: string, value: unknown) { return { method, body: JSON.stringify(value) }; }
function scheduleLabel(job: GoalJob) {
  const schedule = job.schedule;
  return schedule.kind === 'at' ? new Date(schedule.at || '').toLocaleString() : schedule.kind === 'every' ? `Every ${Math.round((schedule.everyMs || 0) / 60000)} min` : schedule.kind === 'cron' ? `${schedule.expr}${schedule.tz ? ` · ${schedule.tz}` : ''}` : schedule.kind;
}
export function DailyGoals() {
  const [jobs, setJobs] = useState<GoalJob[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => { try { const data = await apiFetch<{ jobs: GoalJob[] }>('/api/goals'); setJobs(data.jobs); setError(''); } catch (error) { setError(errorText(error)); } finally { setLoading(false); } }, []);
  useEffect(() => { const initial = window.setTimeout(load, 0); const timer = window.setInterval(load, 30000); return () => { window.clearTimeout(initial); window.clearInterval(timer); }; }, [load]);
  const today = new Date().toDateString();
  const daily = jobs.filter((job) => (job.enabled && job.state?.nextRunAtMs && new Date(job.state.nextRunAtMs).toDateString() === today) || (job.state?.lastRunAtMs && new Date(job.state.lastRunAtMs).toDateString() === today));
  return <div className="space-y-2 pt-2"><div className="flex justify-between items-center text-[11px] text-[#aaa297] px-1"><span>Today's goals</span><button title="Refresh today's goals" onClick={load}><RefreshCw size={12} /></button></div>{error && <Notice error>{error}</Notice>}{loading ? <Notice>Loading scheduled tasks…</Notice> : daily.length === 0 ? <Notice>No tasks scheduled or completed today.</Notice> : daily.map((job) => { const upcoming = job.enabled && job.state?.nextRunAtMs && new Date(job.state.nextRunAtMs).toDateString() === today; return <div key={job.id} className="rounded-xl border border-[#25211c] p-3"><p className="text-[12px] text-[#dcd4c8]">{job.name}</p><p className="text-[10px] text-[#847a6d] mt-1">{upcoming ? 'Next: ' : `${job.state?.lastRunStatus || 'Ran'} · `}{new Date(upcoming ? job.state!.nextRunAtMs! : job.state!.lastRunAtMs!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p><p className="text-[10px] text-[#9a9388] mt-1 line-clamp-3">{job.payload.message || job.payload.text}</p></div>; })}</div>;
}

function GoalsView() {
  const [jobs, setJobs] = useState<GoalJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<GoalJob | 'new' | null>(null);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [kind, setKind] = useState('cron');
  const [value, setValue] = useState('0 9 * * *');
  const [tz, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const load = useCallback(async () => { try { setJobs((await apiFetch<{ jobs: GoalJob[] }>('/api/goals')).jobs); setError(''); } catch (error) { setError(errorText(error)); } finally { setLoading(false); } }, []);
  useEffect(() => { const initial = window.setTimeout(load, 0); const poll = window.setInterval(load, 30000); return () => { window.clearTimeout(initial); window.clearInterval(poll); }; }, [load]);
  const action = async (work: () => Promise<unknown>) => { setBusy(true); setError(''); try { await work(); await load(); } catch (error) { setError(errorText(error)); } finally { setBusy(false); } };
  const edit = (job: GoalJob | 'new') => {
    setEditing(job); setName(job === 'new' ? '' : job.name); setMessage(job === 'new' ? '' : String(job.payload.message || job.payload.text || ''));
    setKind(job === 'new' ? 'cron' : job.schedule.kind);
    setValue(job === 'new' ? '0 9 * * *' : job.schedule.kind === 'cron' ? job.schedule.expr || '' : job.schedule.kind === 'every' ? String((job.schedule.everyMs || 60000) / 60000) : job.schedule.at ? new Date(new Date(job.schedule.at).getTime() - new Date(job.schedule.at).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
    setTz(job === 'new' ? Intl.DateTimeFormat().resolvedOptions().timeZone : job.schedule.tz || Intl.DateTimeFormat().resolvedOptions().timeZone);
  };
  const save = async () => {
    if (!name.trim() || !message.trim() || !value.trim()) { setError('Enter a name, instructions, and schedule.'); return; }
    if (kind === 'every' && (!Number.isFinite(Number(value)) || Number(value) < 1)) { setError('The interval must be at least one minute.'); return; }
    if (kind === 'at' && (!Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now())) { setError('Choose a valid future date and time.'); return; }
    const schedule = kind === 'cron' ? { kind, expr: value, tz } : kind === 'every' ? { kind, everyMs: Number(value) * 60000 } : { kind, at: new Date(value).toISOString() };
    await action(async () => {
      if (editing === 'new') await apiFetch('/api/goals', jsonInit('POST', { name, schedule, payload: { kind: 'agentTurn', message }, sessionTarget: 'isolated', wakeMode: 'now', enabled: true }));
      else if (editing) await apiFetch(`/api/goals/${encodeURIComponent(editing.id)}`, jsonInit('PATCH', { patch: { name, schedule, payload: { ...editing.payload, ...(editing.payload.kind === 'systemEvent' ? { text: message } : { message }) } }, expectedConfigRevision: editing.configRevision }));
      setEditing(null);
    });
  };
  return <div className="space-y-4"><div className="flex items-center justify-between"><p className="text-[12px] text-[#847b6d]">Scheduled tasks run through your OpenClaw agent.</p><div className="flex gap-2"><button className={buttonClass} title="Refresh goals" disabled={busy} onClick={load}><RefreshCw size={13} /></button><button className={buttonClass} onClick={() => edit('new')}><Plus size={13} />New goal</button></div></div>{error && <Notice error>{error}</Notice>}
    {editing && <div className={`${cardClass} space-y-3`}><div className="flex justify-between text-sm"><span>{editing === 'new' ? 'Schedule a goal' : 'Edit goal'}</span><button title="Close editor" onClick={() => setEditing(null)}><X size={14} /></button></div><Field label="Name"><input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="Agent instructions"><textarea rows={4} className={inputClass} value={message} onChange={(event) => setMessage(event.target.value)} /></Field><Field label="Schedule"><select className={inputClass} value={kind} onChange={(event) => { setKind(event.target.value); setValue(event.target.value === 'cron' ? '0 9 * * *' : event.target.value === 'every' ? '60' : ''); }}><option value="cron">Recurring cron expression</option><option value="every">Every interval</option><option value="at">Once at a date and time</option>{!['cron', 'every', 'at'].includes(kind) && <option value={kind}>{kind}</option>}</select></Field><Field label={kind === 'every' ? 'Interval in minutes' : kind === 'at' ? 'Date and time (your timezone)' : 'Cron expression'} hint={kind === 'cron' ? 'Minute · hour · day · month · weekday' : undefined}><input className={inputClass} type={kind === 'at' ? 'datetime-local' : kind === 'every' ? 'number' : 'text'} value={value} onChange={(event) => setValue(event.target.value)} /></Field>{kind === 'cron' && <Field label="Timezone"><input className={inputClass} value={tz} onChange={(event) => setTz(event.target.value)} /></Field>}<button disabled={busy || !['cron', 'every', 'at'].includes(kind)} className={buttonClass} onClick={save}><Save size={12} />{busy ? 'Saving…' : 'Save goal'}</button></div>}
    {loading ? <Notice>Loading scheduled tasks…</Notice> : jobs.length === 0 ? <Notice>No scheduled tasks yet. Create a goal to give your agent something to do later.</Notice> : jobs.map((job) => <div className={`${cardClass} space-y-3`} key={job.id}><div className="flex items-start justify-between gap-3"><div><h3 className="text-[13px] font-medium">{job.name}</h3><p className="text-[11px] text-[#9a8c78] mt-1">{scheduleLabel(job)}</p><p className="text-[10px] text-[#756e63] mt-1">{job.enabled ? 'Enabled' : 'Paused'}{job.state?.nextRunAtMs ? ` · Next: ${new Date(job.state.nextRunAtMs).toLocaleString()}` : ''}{job.state?.lastRunStatus ? ` · Last run: ${job.state.lastRunStatus}` : ''}</p></div><button className={buttonClass} disabled={busy} onClick={() => edit(job)}>Edit</button></div><p className="text-[12px] text-[#b0a89c] whitespace-pre-wrap">{job.payload.message || job.payload.text || 'Advanced task payload'}</p>{job.state?.lastError && <Notice error>{job.state.lastError}</Notice>}<div className="flex gap-2 flex-wrap"><button disabled={busy} className={buttonClass} onClick={() => action(() => apiFetch(`/api/goals/${encodeURIComponent(job.id)}/run`, jsonInit('POST', {})))}><Play size={12} />Run now</button><button disabled={busy} className={buttonClass} onClick={() => action(() => apiFetch(`/api/goals/${encodeURIComponent(job.id)}`, jsonInit('PATCH', { patch: { enabled: !job.enabled }, expectedConfigRevision: job.configRevision })))}>{job.enabled ? 'Pause' : 'Resume'}</button><button className={buttonClass} disabled={busy} title="Delete goal" onClick={() => setDeleteId(job.id)}><Trash2 size={12} /></button></div>{deleteId === job.id && <div className="flex items-center gap-2 text-[11px]"><span>Delete this scheduled task?</span><button className={buttonClass} disabled={busy} onClick={() => action(async () => { await apiFetch(`/api/goals/${encodeURIComponent(job.id)}`, { method: 'DELETE' }); setDeleteId(null); })}>Delete</button><button className={buttonClass} onClick={() => setDeleteId(null)}>Cancel</button></div>}</div>)}
  </div>;
}

interface LibraryFile { name: string; path: string; sessionId: string; size?: number; updatedAtMs?: number; mimeType?: string }
function LibraryView() {
  const [kind, setKind] = useState('artifacts');
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<LibraryFile | null>(null);
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => { setLoading(true); setError(''); try { const result = await apiFetch<{ files: LibraryFile[]; truncated?: boolean }>(`/api/library?kind=${kind}`); setFiles(result.files); setTruncated(Boolean(result.truncated)); } catch (error) { setError(errorText(error)); } finally { setLoading(false); } }, [kind]);
  useEffect(() => { const initial = window.setTimeout(load, 0); let cancelled = false; const poll = window.setInterval(() => { void apiFetch<{ files: LibraryFile[]; truncated?: boolean }>(`/api/library?kind=${kind}`).then((result) => { if (!cancelled) { setFiles(result.files); setTruncated(Boolean(result.truncated)); } }).catch((error: unknown) => { if (!cancelled) setError(errorText(error)); }); }, 30000); return () => { cancelled = true; window.clearTimeout(initial); window.clearInterval(poll); }; }, [load, kind]);
  const url = (file: LibraryFile) => `/api/library/file?sessionId=${encodeURIComponent(file.sessionId)}&path=${encodeURIComponent(file.path)}`;
  const preview = async (file: LibraryFile) => { setSelected(file); setContent(''); setError(''); if (kind === 'media') return; setLoading(true); try { const data = await apiFetch<{ content?: string; text?: string; file?: { content?: string } }>(url(file)); setContent(data.content ?? data.text ?? data.file?.content ?? 'This file has no text preview. Use Download to open it.'); } catch (error) { setError(errorText(error)); } finally { setLoading(false); } };
  return <div className="space-y-4"><div className="flex justify-between"><div className="inline-flex rounded-full bg-[#111] border border-[#26211b] p-1">{['artifacts', 'media'].map((tab) => <button key={tab} onClick={() => { setKind(tab); setSelected(null); setLoading(true); }} className={`rounded-full px-4 py-1.5 text-[11px] capitalize ${kind === tab ? 'bg-[#2b231a] text-[#dfc5a3]' : 'text-[#8e8578]'}`}>{tab}</button>)}</div><button onClick={load} className={buttonClass} title="Refresh library"><RefreshCw size={13} /></button></div>{truncated && <Notice>The library search reached its limit. Some workspace files may not be listed.</Notice>}{error && <Notice error>{error}</Notice>}{selected ? <div className={`${cardClass} space-y-3`}><div className="flex items-center justify-between"><button className={buttonClass} onClick={() => setSelected(null)}><ArrowLeft size={12} />Back</button><span className="text-[12px] truncate px-3">{selected.name}</span><a className={buttonClass} href={`${url(selected)}&download=1`} target="_blank" rel="noreferrer">Download</a></div>{loading ? <Notice>Loading preview…</Notice> : kind === 'media' ? (selected.mimeType?.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(selected.name)) ? <video controls onError={() => setError('This video could not be previewed. Use Download to open it.')} className="w-full rounded-xl max-h-[60vh]" src={`${url(selected)}&raw=1`} /> : (selected.mimeType?.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac)$/i.test(selected.name)) ? <audio controls onError={() => setError('This audio could not be previewed. Use Download to open it.')} className="w-full" src={`${url(selected)}&raw=1`} /> : <img className="max-w-full max-h-[60vh] mx-auto rounded-xl" alt={selected.name} onError={() => setError('This media could not be previewed. Use Download to open it.')} src={`${url(selected)}&raw=1`} /> : /\.(md|markdown)$/i.test(selected.name) ? <MarkdownView content={content} /> : <pre className="overflow-auto text-[11px] text-[#bcb5a9] whitespace-pre-wrap select-text">{content}</pre>}</div> : loading ? <Notice>Loading library…</Notice> : files.length === 0 ? <Notice>No {kind} yet. Files created by your agent appear here.</Notice> : <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">{files.map((file) => <button key={`${file.sessionId}:${file.path}`} onClick={() => preview(file)} className={`${cardClass} text-left hover:border-[#69543a] cursor-pointer`}><div className="text-[#c0a17b] mb-3">{kind === 'media' ? <Image size={22} /> : <FileText size={22} />}</div><p className="text-[12px] truncate">{file.name}</p><p className="text-[10px] text-[#7c7264] mt-1">{file.size ? `${(file.size / 1024).toFixed(1)} KB` : file.mimeType || 'File'}{file.updatedAtMs ? ` · ${new Date(file.updatedAtMs).toLocaleDateString()}` : ''}</p></button>)}</div>}</div>;
}

type Config = Record<string, unknown>;
interface Schema { type?: string | string[]; properties?: Record<string, Schema>; additionalProperties?: boolean | Schema; items?: Schema; anyOf?: Schema[]; oneOf?: Schema[]; enum?: unknown[]; const?: unknown; title?: string; description?: string; default?: unknown; minimum?: number; maximum?: number; format?: string }
interface SchemaResult { schema: Schema; uiHints?: Record<string, { label?: string; help?: string; sensitive?: boolean }> }
function object(value: unknown): value is Config { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function withValue(source: Config, key: string, value: unknown) { const next = { ...source }; if (value === undefined) delete next[key]; else next[key] = value; return next; }
function difference(before: unknown, after: unknown): unknown {
  if (JSON.stringify(before) === JSON.stringify(after)) return undefined;
  if (!object(before) || !object(after)) return after;
  const result: Config = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const changed = key in after ? difference(before[key], after[key]) : null;
    if (changed !== undefined) result[key] = changed;
  }
  return Object.keys(result).length ? result : undefined;
}
function JsonField({ value, onChange, label }: { value: unknown; onChange: (value: unknown) => void; label: string }) {
  const [draft, setDraft] = useState(JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = useState('');
  return <Field label={label} hint="Apply valid JSON to update this value."><textarea className={`${inputClass} font-mono`} rows={8} value={draft} onChange={(event) => setDraft(event.target.value)} /><div className="flex gap-2"><button type="button" className={buttonClass} onClick={() => { try { onChange(JSON.parse(draft)); setError(''); } catch { setError('Enter valid JSON.'); } }}>Apply JSON</button>{error && <span className="text-[11px] text-red-300">{error}</span>}</div></Field>;
}
function SchemaFields({ schema, value, onChange, path, hints, depth = 0 }: { schema: Schema; value: unknown; onChange: (value: unknown) => void; path: string; hints: SchemaResult['uiHints']; depth?: number }) {
  const hint = hints?.[path];
  const options = schema.enum || (schema.anyOf || schema.oneOf)?.filter((item) => item.const !== undefined).map((item) => item.const);
  const alternatives = schema.anyOf || schema.oneOf;
  const effective = alternatives?.find((item) => item.type === (object(value) ? 'object' : typeof value) || (Array.isArray(value) && item.type === 'array')) || schema;
  const label = hint?.label || schema.title || path.split('.').at(-1) || 'Configuration';
  const help = hint?.help || schema.description;
  if (effective.properties || effective.type === 'object') {
    const data = object(value) ? value : {};
    if (depth > 5) return <JsonField label={label} value={value} onChange={onChange} />;
    const entries = new Set([...Object.keys(effective.properties || {}), ...Object.keys(data)]);
    return <details open={depth === 0} className="space-y-3 rounded-xl border border-[#24201a] p-3"><summary className="text-[12px] text-[#d0c0aa] cursor-pointer">{label}</summary>{help && <p className="text-[10px] text-[#7c7469]">{help}</p>}{[...entries].map((key) => <SchemaFields key={key} schema={effective.properties?.[key] || (object(effective.additionalProperties) ? effective.additionalProperties as Schema : {})} value={data[key]} onChange={(next) => onChange(withValue(data, key, next))} path={path ? `${path}.${key}` : key} hints={hints} depth={depth + 1} />)}{effective.additionalProperties !== false && <details className="text-[11px] text-[#817767]"><summary className="cursor-pointer">Additional properties / JSON</summary><div className="mt-3"><JsonField key={JSON.stringify(data)} label={label} value={data} onChange={onChange} /></div></details>}</details>;
  }
  if (options?.length) return <Field label={label} hint={help}><select className={inputClass} value={value === undefined ? '' : JSON.stringify(value)} onChange={(event) => onChange(event.target.value === '' ? undefined : JSON.parse(event.target.value))}><option value="">Default / unset</option>{options.map((option) => <option key={JSON.stringify(option)} value={JSON.stringify(option)}>{String(option)}</option>)}</select></Field>;
  if (effective.type === 'boolean' || typeof value === 'boolean') return <Field label={label} hint={help}><select className={inputClass} value={value === undefined ? '' : String(value)} onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value === 'true')}><option value="">Default / unset</option><option value="true">Enabled</option><option value="false">Disabled</option></select></Field>;
  if (effective.type === 'array' || Array.isArray(value) || object(value) || (!effective.type && value === undefined)) return <JsonField value={value} onChange={onChange} label={label} />;
  const numeric = effective.type === 'number' || effective.type === 'integer' || typeof value === 'number';
  const secret = hint?.sensitive || /(^|\.)(apiKey|token|password|secret|credential)$/i.test(path);
  return <Field label={label} hint={help}><input className={inputClass} autoComplete={secret ? 'new-password' : 'off'} type={secret ? 'password' : numeric ? 'number' : 'text'} min={effective.minimum} max={effective.maximum} value={value === undefined || value === null ? '' : String(value)} placeholder={secret && value ? 'Stored credential' : effective.default !== undefined ? String(effective.default) : 'Default / unset'} onChange={(event) => onChange(numeric ? event.target.value === '' ? undefined : Number(event.target.value) : event.target.value)} /></Field>;
}

const sections = [
  { id: 'models', title: 'Models & credentials', keys: ['models', 'auth', 'secrets', 'env', 'agents'] },
  { id: 'connectors', title: 'Connectors & plugins', keys: ['plugins', 'skills', 'bindings', 'hooks', 'mcp'] },
  { id: 'channels', title: 'Messaging channels', keys: ['channels', 'messages', 'broadcast', 'session'] },
  { id: 'permissions', title: 'Storage & permissions', keys: ['tools', 'browser', 'memory', 'media', 'approvals', 'commands', 'sandbox', 'filesystem'] },
  { id: 'notifications', title: 'Notifications', keys: ['cron', 'talk', 'audio'] },
  { id: 'appearance', title: 'Appearance', keys: ['ui'] },
  { id: 'gateway', title: 'Gateway & runtime', keys: ['gateway', 'logging', 'diagnostics', 'update', 'discovery', 'web', 'canvasHost', 'nodeHost', 'wizard'] },
  { id: 'all', title: 'All OpenClaw settings', keys: [] },
  { id: 'advanced', title: 'Advanced JSON', keys: [] },
];

function SettingsView() {
  const { refresh } = useChat();
  const [snapshot, setSnapshot] = useState<{ config: Config; hash: string; valid?: boolean; issues?: unknown[] } | null>(null);
  const [schema, setSchema] = useState<SchemaResult | null>(null);
  const [draft, setDraft] = useState<Config>({});
  const [section, setSection] = useState('models');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [contrast, setContrast] = useState(() => localStorage.getItem('mused-contrast') || 'default');
  const load = useCallback(async () => { setLoading(true); setError(''); try { const [config, schema] = await Promise.all([apiFetch<{ config: Config; hash: string; valid?: boolean; issues?: unknown[] }>('/api/settings'), apiFetch<SchemaResult>('/api/settings/schema')]); setSnapshot(config); setDraft(config.config || {}); setSchema(schema); } catch (error) { setError(errorText(error)); } finally { setLoading(false); } }, []);
  useEffect(() => { const initial = window.setTimeout(load, 0); return () => window.clearTimeout(initial); }, [load]);
  const changed = snapshot ? difference(snapshot.config, draft) : undefined;
  const save = async () => { if (!snapshot || !changed) return; setBusy(true); setError(''); setStatus(''); try { await apiFetch('/api/settings', jsonInit('PATCH', { patch: changed, baseHash: snapshot.hash, replacePaths: arrayReplacementPaths(snapshot.config, draft) })); await load(); await refresh(); setStatus('Settings saved. The gateway applies changes and may restart.'); } catch (error) { setError(errorText(error)); } finally { setBusy(false); } };
  const current = sections.find((item) => item.id === section)!;
  const keys = section === 'all' ? [...new Set([...Object.keys(schema?.schema.properties || {}), ...Object.keys(draft)])] : current.keys.filter((key) => schema?.schema.properties?.[key] || key in draft);
  return <div className="space-y-4"><div className="flex items-center justify-between gap-3"><p className="text-[12px] text-[#847b6d]">Configure your self-hosted OpenClaw gateway.</p><div className="flex gap-2"><button title="Reload settings" disabled={busy} className={buttonClass} onClick={load}><RefreshCw size={13} /></button><button disabled={busy || !changed || loading} className={buttonClass} onClick={save}><Save size={13} />{busy ? 'Saving…' : 'Save changes'}</button></div></div>{error && <Notice error>{error}</Notice>}{status && <Notice>{status}</Notice>}{snapshot?.valid === false && <Notice error>OpenClaw reported configuration issues: {JSON.stringify(snapshot.issues)}</Notice>}
    <div className="flex gap-1.5 flex-wrap">{sections.map((item) => <button key={item.id} className={`${buttonClass} ${section === item.id ? '!border-[#846748] !bg-[#322619]' : '!bg-[#101010] !text-[#9d9283]'}`} onClick={() => setSection(item.id)}>{item.title}</button>)}</div>
    <SettingsActions key={section} section={section} />{section === 'models' && <><SetupWizard /><CredentialsSettings /></>}{section === 'channels' && <SetupWizard flow="channels" />}{loading ? <Notice>Loading configuration and its schema…</Notice> : schema && snapshot && <div className={`${cardClass} space-y-5`}><h3 className="text-[13px] font-medium text-[#dfd1bd]">{current.title}</h3>{section === 'advanced' ? <JsonField key={snapshot.hash} label="Full configuration" value={draft} onChange={(value) => { if (object(value)) { setDraft(value); setError(''); } else setError('Configuration must be a JSON object.'); }} /> : keys.map((key) => <SchemaFields key={`${snapshot.hash}:${key}`} schema={schema.schema.properties?.[key] || { type: 'object' }} value={draft[key]} onChange={(value) => setDraft((previous) => withValue(previous, key, value))} path={key} hints={schema.uiHints} />)}{section !== 'advanced' && keys.length === 0 && <Notice>This gateway schema has no dedicated settings in this section. All settings remain available in All OpenClaw settings.</Notice>}{section === 'appearance' && <Field label="Interface contrast" hint="Saved in this browser."><select className={inputClass} value={contrast} onChange={(event) => { setContrast(event.target.value); localStorage.setItem('mused-contrast', event.target.value); document.documentElement.style.filter = event.target.value === 'high' ? 'contrast(1.15)' : ''; }}><option value="default">Original black & bronze</option><option value="high">Higher contrast</option></select></Field>}{section === 'notifications' && <div className="space-y-2"><p className="text-[11px] text-[#928577]">Browser notifications require permission on this device.</p><button className={buttonClass} onClick={async () => { if (!('Notification' in window)) { setError('This browser does not support notifications.'); return; } try { const permission = await Notification.requestPermission(); localStorage.setItem('mused-notifications', permission === 'granted' ? 'enabled' : 'disabled'); setStatus('Browser notifications: ' + permission); } catch (error) { setError(errorText(error)); } }}>Enable browser notifications</button></div>}<p className="text-[10px] text-[#6e665b]">Stored secrets are masked. Unchanged credentials are preserved. Changes are checked against the current configuration revision.</p></div>}
  </div>;
}

export function WorkspaceViews({ activeNav }: { activeNav: string }) {
  const { setActiveNav } = useChat();
  const title = activeNav === 'idea' ? 'Ideas' : activeNav.charAt(0).toUpperCase() + activeNav.slice(1);
  return <><header className="h-[58px] border-b border-[#181818] px-5 flex items-center gap-3 shrink-0"><button className="text-[#9d8b73] md:hidden" title="Back to chat" onClick={() => setActiveNav('chat')}><ArrowLeft size={16} /></button><h1 className="text-[14px] font-medium text-[#e0d7c9]">{title}</h1></header><div className="flex-1 overflow-y-auto p-5 md:p-7"><div className="mx-auto max-w-[900px]">{activeNav === 'library' ? <LibraryView /> : activeNav === 'goals' ? <GoalsView /> : activeNav === 'settings' ? <SettingsView /> : activeNav === 'feed' || activeNav === 'idea' ? null : <Notice>Select a conversation from Search to continue chatting.</Notice>}</div></div></>;
}

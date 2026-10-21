import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '../context/ChatContext';
import { apiFetch } from '../services/api';
import { hermesWorkspaceApi, jsonWrite } from '../services/hermes-workspace';
import { buttonClass, cardClass, ConfirmButton, EmptyState, Field, inputClass, Notice, Skeleton, StatusPill } from '../components/WorkspaceUI';
import { errorText } from '../components/workspaceUtils';
import { useToast } from '../context/ToastContext';
import { DogeshAvatar } from '../components/DogeshAvatar';
import { BrowserViewer } from '../components/BrowserViewer';
import { clearBotAvatar, readAvatarFile, setBotAvatar } from '../services/avatars';

function useWorkspaceResource<T>(profile: string, operation: string, query: Record<string, string> = {}) {
  const api = useMemo(() => hermesWorkspaceApi(profile), [profile]);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const invalidate = useCallback(() => { sequence.current++; }, []);
  const queryKey = JSON.stringify(query);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const result = await api<T>(operation, {}, JSON.parse(queryKey));
      if (sequence.current === current) { setData(result); setError(''); }
    } catch (error) { if (sequence.current === current) setError(errorText(error)); }
  }, [api, operation, queryKey]);
  useEffect(() => { const timer = window.setTimeout(load, 0); return () => { invalidate(); window.clearTimeout(timer); }; }, [load, invalidate]);
  const action = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await work(); await load(); }
    catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  };
  return { api, data, error, busy, load, action };
}

interface Job { id: string; name: string; prompt?: string; schedule: string | Record<string, unknown>; enabled?: boolean; state?: string; next_run_at?: string; last_run_at?: string; last_status?: string; last_error?: string }

export function HermesGoals({ profile, compact = false }: { profile: string; compact?: boolean }) {
  const { api, data, error, busy, load, action } = useWorkspaceResource<Job[]>(profile, 'jobs');
  const { toast } = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [schedule, setSchedule] = useState('0 9 * * *');
  const [runs, setRuns] = useState<unknown>(null);
  const edit = (job?: Job) => { setEditing(job?.id || 'new'); setName(job?.name || ''); setPrompt(job?.prompt || ''); setSchedule(typeof job?.schedule === 'string' ? job.schedule : String(job?.schedule?.display || job?.schedule?.value || job?.schedule?.expr || '0 9 * * *')); };
  const submit = () => action(async () => {
    await api(editing === 'new' ? 'jobs' : `jobs/${encodeURIComponent(editing!)}`, jsonWrite(editing === 'new' ? 'POST' : 'PUT', { name: name.trim(), prompt: prompt.trim(), schedule: schedule.trim() }));
    setEditing(null);
    toast(editing === 'new' ? 'Goal created.' : 'Goal updated.');
  });
  return <div className="space-y-3"><div className="flex items-center justify-between gap-2"><h2 className="text-sm text-ink">{compact ? 'Scheduled goals' : 'Goals & schedules'}</h2><div className="flex gap-2"><button className={buttonClass} disabled={busy} onClick={load}>Refresh</button><button className={buttonClass} disabled={busy} onClick={() => edit()}>New goal</button></div></div>
    {!compact && <Notice>Hermes runs these instructions for this bot on the schedule you choose. Results are saved locally. Times use this bot’s configured timezone.</Notice>}
    {error && <Notice error>{error}</Notice>}
    {editing && <div className={`${cardClass} space-y-3`}><Field label="Goal name"><input className={inputClass} value={name} onChange={event => setName(event.target.value)} /></Field><Field label="Instructions"><textarea className={`${inputClass} min-h-24`} value={prompt} onChange={event => setPrompt(event.target.value)} /></Field><Field label="Schedule" hint="Cron expression (0 9 * * *), an interval (every 2h), or a one-time date supported by Hermes."><input className={inputClass} value={schedule} onChange={event => setSchedule(event.target.value)} /></Field><button className={buttonClass} disabled={busy || !name.trim() || !prompt.trim() || !schedule.trim()} onClick={submit}>Save goal</button> <button className={buttonClass} disabled={busy} onClick={() => setEditing(null)}>Cancel</button></div>}
    {!data && !error && <div className="space-y-3">{[0, 1].map((index) => <div key={index} className={`${cardClass} space-y-2`}><Skeleton className="h-4 w-1/3" /><Skeleton className="h-3 w-1/2" /><Skeleton className="h-3 w-2/3" /></div>)}</div>}{data?.length === 0 && <EmptyState title="No scheduled goals for this bot" description="Create a goal to have Hermes run instructions on your schedule." />}
    {data?.map(job => <div key={job.id} className={`${cardClass} space-y-2`}><h3 className="text-sm text-ink">{job.name || job.id}</h3><div className="flex items-center gap-2 flex-wrap"><p className="text-xs text-muted">{typeof job.schedule === 'string' ? job.schedule : JSON.stringify(job.schedule)}</p><StatusPill status={job.enabled === false || job.state === 'paused' ? 'paused' : 'scheduled'} /></div><p className="text-xs whitespace-pre-wrap text-soft">{job.prompt}</p>{job.last_error && <Notice error>{job.last_error}</Notice>}<div className="flex flex-wrap gap-2"><button className={buttonClass} disabled={busy} onClick={() => edit(job)}>Edit</button><button className={buttonClass} disabled={busy} onClick={() => action(() => api(`jobs/${encodeURIComponent(job.id)}/${job.enabled === false || job.state === 'paused' ? 'resume' : 'pause'}`, jsonWrite('POST', {})))}>{job.enabled === false || job.state === 'paused' ? 'Resume' : 'Pause'}</button><button className={buttonClass} disabled={busy} onClick={() => action(() => api(`jobs/${encodeURIComponent(job.id)}/trigger`, jsonWrite('POST', {})))}>Run now</button><button className={buttonClass} disabled={busy} onClick={() => action(async () => setRuns(await api(`jobs/${encodeURIComponent(job.id)}/runs`)))}>Run history</button><ConfirmButton className={buttonClass} disabled={busy} tone="danger" confirmLabel="Delete" message="Delete this goal? This cannot be undone." onConfirm={() => { void action(async () => { await api(`jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' }); toast('Goal deleted.'); }); }}>Delete</ConfirmButton></div></div>)}
    {runs !== null && <div className={cardClass}><button className={buttonClass} onClick={() => setRuns(null)}>Close history</button><pre className="text-xs whitespace-pre-wrap text-muted mt-3">{JSON.stringify(runs, null, 2)}</pre></div>}
  </div>;
}

interface FileEntry { name: string; path: string; directory: boolean; size?: number }
interface FilePreview { name: string; dataUrl: string; mimeType: string; size: number }

export function HermesLibrary({ profile }: { profile: string }) {
  const [directory, setDirectory] = useState('');
  const { api, data, error, busy, load, action } = useWorkspaceResource<{ entries: FileEntry[] }>(profile, 'files', { path: directory });
  const [preview, setPreview] = useState<FilePreview | null>(null);
  return <div className="space-y-3"><div className="flex items-center justify-between"><h2 className="text-sm text-ink">Bot workspace</h2><button className={buttonClass} disabled={busy} onClick={load}>Refresh</button></div><Notice>Files created in this bot’s dashboard workspace. Sensitive files and paths outside this workspace are excluded. Downloads and previews support files up to 2 MB.</Notice>{error && <Notice error>{error}</Notice>}
    <div className="flex items-center gap-2"><button className={buttonClass} disabled={!directory || busy} onClick={() => { setDirectory(directory.split('/').slice(0, -1).join('/')); setPreview(null); }}>Up</button><span className="text-xs text-muted">/{directory}</span></div>
    {!data && !error && <div className="space-y-3">{[0, 1, 2].map((index) => <div key={index} className={cardClass}><Skeleton className="h-3.5 w-1/3" /></div>)}</div>}{data?.entries.length === 0 && <EmptyState title="No files in this directory yet" description="Files created in this bot’s dashboard workspace appear here." />}
    {data?.entries.map(file => <button key={file.path} className={`${cardClass} w-full text-left cursor-pointer disabled:opacity-40`} disabled={busy} onClick={() => file.directory ? (setDirectory(file.path), setPreview(null)) : action(async () => setPreview(await api<FilePreview>('file', {}, { path: file.path })))}><span className="text-xs text-ink">{file.directory ? 'Folder: ' : ''}{file.name}</span>{file.size !== undefined && <span className="text-[10px] text-muted ml-2">{file.size.toLocaleString()} bytes</span>}</button>)}
    {preview && <div className={`${cardClass} space-y-3`}><div className="flex items-center gap-3"><h3 className="text-sm text-ink">{preview.name}</h3><a className={buttonClass} href={preview.dataUrl} download={preview.name}>Download</a><button className={buttonClass} onClick={() => setPreview(null)}>Close</button></div>{/^image\/(png|jpeg|webp|gif)$/.test(preview.mimeType) ? <img src={preview.dataUrl} alt={preview.name} className="max-h-[500px] rounded-xl" /> : <Notice>Download this file to view it.</Notice>}</div>}
  </div>;
}

interface Skill { name: string; description?: string; enabled: boolean; provenance?: string; usage?: number }
interface LearningNode { id: string; label: string; kind: string; memorySource?: string }

export function HermesMemories({ profile }: { profile: string }) {
  const { api, data, error, busy, action, load } = useWorkspaceResource<{ nodes: LearningNode[] }>(profile, 'learning');
  const { toast } = useToast();
  const [entry, setEntry] = useState<{ id: string; content: string; label: string } | null>(null);
  const [draft, setDraft] = useState('');
  return <div className="space-y-3 pt-2">
    <div className="flex items-center justify-between">
      <h3 className="text-sm md:text-base font-semibold text-ink">Memories</h3>
      <button className={buttonClass} disabled={busy} onClick={load}>Refresh memories</button>
    </div>
    {error && <Notice error>{error}</Notice>}
    {data?.nodes.filter(node => node.kind === 'memory').map(node => (
      <button key={node.id} className={`${cardClass} w-full text-left cursor-pointer hover:border-accent/45 transition-colors`} disabled={busy} onClick={() => action(async () => { const result = await api<{ id: string; content: string; label: string }>('learning/node', {}, { id: node.id }); setEntry(result); setDraft(result.content); })}>
        <span className="text-xs md:text-sm font-medium text-ink">{node.label}</span>
        <p className="text-xs text-muted mt-1">{node.memorySource === 'profile' ? 'USER.md' : 'MEMORY.md'}</p>
      </button>
    ))}
    {data && !data.nodes.some(node => node.kind === 'memory') && <Notice>No saved memories for this bot yet. Ask it to remember something in chat.</Notice>}
    {entry && <div className={`${cardClass} space-y-3`}><Field label="Memory entry"><textarea className={`${inputClass} min-h-36 text-xs md:text-sm leading-relaxed font-mono`} value={draft} onChange={event => setDraft(event.target.value)} /></Field><p className="text-xs text-muted">Hermes revalidates the selected entry and its memory budget when saving.</p><div className="flex gap-2 flex-wrap"><button className={buttonClass} disabled={busy || !draft.trim()} onClick={() => action(async () => { await api('learning/node', jsonWrite('PUT', { id: entry.id, content: draft })); setEntry(null); toast('Memory saved.'); })}>Save memory</button> <ConfirmButton className={buttonClass} disabled={busy} tone="danger" confirmLabel="Delete" message="Delete this memory entry? This cannot be undone." onConfirm={() => { void action(async () => { await api('learning/node', jsonWrite('DELETE', { id: entry.id })); setEntry(null); toast('Memory entry deleted.'); }); }}>Delete entry</ConfirmButton> <button className={buttonClass} disabled={busy} onClick={() => setEntry(null)}>Cancel</button></div></div>}
  </div>;
}

export function HermesWorkshop({ profile }: { profile: string }) {
  const { activeSessionId } = useChat();
  const { api, data, error, busy, action, load } = useWorkspaceResource<Skill[]>(profile, 'skills');
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [reviewId, setReviewId] = useState('');
  const [reviewOutput, setReviewOutput] = useState('');
  const [policyStatus, setPolicyStatus] = useState('');
  const review = (operation: 'pending' | 'diff' | 'approve' | 'reject', confirm = false) => action(async () => {
    const result = await api<{ output: string }>('skill-review', jsonWrite('POST', { sessionKey: activeSessionId, action: operation, ...(operation !== 'pending' ? { id: reviewId.trim() } : {}), ...(confirm ? { confirm: true } : {}) }));
    setReviewOutput(result.output);
  });
  return <div className="space-y-5"><div className="flex justify-between items-center"><h2 className="text-base md:text-lg font-semibold text-ink">Skills & learning</h2><button className={buttonClass} disabled={busy} onClick={load}>Refresh</button></div>{error && <Notice error>{error}</Notice>}
    <section className={`${cardClass} space-y-3.5`}><h3 className="text-sm md:text-base font-semibold text-ink">Autonomous skill proposals</h3><Notice>Use Hermes’s native pending queue to review agent-generated skill changes. Decisions use this bot’s selected native conversation. Operator edits below save directly.</Notice><button className={buttonClass} disabled={busy} onClick={() => action(async () => { await apiFetch(`/api/hermes/config?profile=${encodeURIComponent(profile)}`, jsonWrite('PUT', { config: { skills: { write_approval: true } } })); setPolicyStatus('Native skill write approval enabled. Agent-generated skill changes will be staged.'); })}>Require approval for agent skill writes</button>{policyStatus && <Notice>{policyStatus}</Notice>}<div className="flex gap-2 flex-wrap"><button className={buttonClass} disabled={busy || !activeSessionId} onClick={() => review('pending')}>List pending proposals</button></div><Field label="Pending proposal ID" hint="Copy the identifier from the native pending list."><input className={inputClass} value={reviewId} onChange={event => setReviewId(event.target.value)} /></Field><div className="flex gap-2"><button className={buttonClass} disabled={busy || !reviewId.trim()} onClick={() => review('diff')}>View diff</button><ConfirmButton className={buttonClass} disabled={busy || !reviewId.trim()} confirmLabel="Approve" message={`Activate proposal ${reviewId}?`} onConfirm={() => { void review('approve', true); }}>Approve</ConfirmButton><ConfirmButton className={buttonClass} disabled={busy || !reviewId.trim()} tone="danger" confirmLabel="Reject" message={`Reject proposal ${reviewId}?`} onConfirm={() => { void review('reject', true); }}>Reject</ConfirmButton></div>{reviewOutput && <pre className="text-xs md:text-sm whitespace-pre-wrap break-words select-text text-soft max-h-96 overflow-auto font-mono p-3 bg-panel rounded-xl border border-hair">{reviewOutput}</pre>}</section>
    <section className="space-y-3.5"><div className="flex justify-between items-center"><h3 className="text-sm md:text-base font-semibold text-ink">Installed skills</h3><button className={buttonClass} disabled={busy} onClick={() => { setSelected('new'); setName(''); setContent(''); }}>Create skill</button></div>{!data && !error && <div className="space-y-3">{[0, 1].map((index) => <div key={index} className={`${cardClass} space-y-2`}><Skeleton className="h-4 w-1/3" /><Skeleton className="h-3 w-2/3" /></div>)}</div>}{data?.length === 0 && <EmptyState title="No skills installed for this bot" description="Skills appear here once installed or proposed." />}{data?.map(skill => <div key={skill.name} className={`${cardClass} space-y-2`}><div className="flex items-center gap-2 flex-wrap"><h4 className="text-xs md:text-sm font-semibold text-ink">{skill.name} · {skill.provenance || 'skill'}</h4><StatusPill status={skill.enabled ? 'enabled' : 'disabled'} /></div><p className="text-xs md:text-sm text-muted">{skill.description}</p><div className="flex gap-2"><button className={buttonClass} disabled={busy} onClick={() => action(async () => { const value = await api<{ content: string }>('skill', {}, { name: skill.name }); setSelected(skill.name); setName(skill.name); setContent(value.content); })}>View / edit</button><button className={buttonClass} disabled={busy} onClick={() => action(() => api('skill/toggle', jsonWrite('PUT', { name: skill.name, enabled: !skill.enabled })))}>{skill.enabled ? 'Disable' : 'Enable'}</button></div></div>)}
    {selected && <div className={`${cardClass} space-y-3.5`}><Field label="Skill name"><input className={inputClass} disabled={selected !== 'new'} value={name} onChange={event => setName(event.target.value)} /></Field><Field label="SKILL.md content"><textarea className={`${inputClass} min-h-64 font-mono text-xs md:text-sm leading-relaxed`} value={content} onChange={event => setContent(event.target.value)} /></Field><Notice>Saving is an explicit operator write to this bot’s skills. Refresh before editing if another person or agent may have changed this skill; the native editor has no revision precondition.</Notice><div className="flex gap-2"><button className={buttonClass} disabled={busy || !name.trim() || !content.trim()} onClick={() => action(async () => { await api('skill', jsonWrite(selected === 'new' ? 'POST' : 'PUT', { name: name.trim(), content })); setSelected(null); })}>Save skill</button> <button className={buttonClass} disabled={busy} onClick={() => setSelected(null)}>Cancel</button></div></div>}</section>
    <HermesMemories profile={profile} />
  </div>;
}

export function BotAvatar({ profile }: { profile: string }) {
  const { agent, agents, refresh } = useChat();
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = (agent?.id === profile ? agent.avatarUrl : agents.find(item => item.id === profile)?.avatarUrl) || '';
  const upload = async (file?: File) => {
    if (!file || busy) return;
    setBusy(true); setError('');
    try {
      await setBotAvatar(profile, await readAvatarFile(file));
      await refresh();
      toast('Bot photo updated.');
    } catch (cause) { setError(errorText(cause)); toast(errorText(cause), 'error'); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  const remove = async () => {
    setBusy(true); setError('');
    try { await clearBotAvatar(profile); await refresh(); toast('Bot photo removed.'); }
    catch (cause) { setError(errorText(cause)); toast(errorText(cause), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <section className="space-y-3">
      <h3 className="text-sm md:text-base font-semibold text-ink">Bot photo</h3>
      <div className="flex items-center gap-4">
        <DogeshAvatar size={72} showEditBadge={false} avatarUrl={current || '/brand/hob-mark.png'} hideStatusDot />
        <div className="space-y-2">
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
            onChange={event => void upload(event.target.files?.[0])} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} disabled={busy} onClick={() => input.current?.click()}>
              {busy ? 'Saving…' : current ? 'Change photo' : 'Upload photo'}
            </button>
            {current && <ConfirmButton className={buttonClass} disabled={busy} tone="danger" confirmLabel="Remove"
              message="Remove this bot's photo? Hermes will fall back to its default mark." onConfirm={() => { void remove(); }}>Remove</ConfirmButton>}
          </div>
        </div>
      </div>
      {error && <Notice error>{error}</Notice>}
      <p className="text-xs text-muted leading-relaxed">Choose a PNG, JPEG, or WebP image up to 2 MB from this device. Hermes stores it as the bot’s native avatar.</p>
    </section>
  );
}

export function HermesIdentity({ profile }: { profile: string }) {
  const { data, api, error, busy, action } = useWorkspaceResource<{ content: string }>(profile, 'soul');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  return (
    <div className="space-y-4 pt-1">
      {error && <Notice error>{error}</Notice>}
      <BotAvatar profile={profile} />
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm md:text-base font-semibold text-ink">Personality & instructions</h3>
          {!editing && (
            <button className={buttonClass} disabled={busy || !data} onClick={() => { setDraft(data?.content || ''); setEditing(true); }}>
              Edit personality
            </button>
          )}
        </div>
        {editing ? (
          <div className="space-y-3">
            <Field label="SOUL.md"><textarea className={`${inputClass} min-h-64 font-mono text-xs md:text-sm leading-relaxed`} value={draft} onChange={event => setDraft(event.target.value)} /></Field>
            <div className="flex gap-2">
              <button className={buttonClass} disabled={busy} onClick={() => action(async () => { await api('soul', jsonWrite('PUT', { content: draft })); setEditing(false); })}>Save personality</button>
              <button className={buttonClass} disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="p-3.5 bg-surface border border-hair rounded-2xl max-h-[320px] overflow-y-auto">
            <pre className="text-xs md:text-[13px] leading-relaxed text-code whitespace-pre-wrap select-text font-mono">{data?.content || 'No custom personality set.'}</pre>
          </div>
        )}
        <p className="text-xs text-muted leading-relaxed">Personality changes apply when Hermes next builds the bot’s context. Configure the model in Settings.</p>
      </section>
      <HermesMemories profile={profile} />
    </div>
  );
}

export function HermesBrowser({ profile }: { profile: string }) {
  const { sendMessage, setActiveNav, isLoading, isPreparing, activeSessionId, sessions, agent, agents } = useChat();
  const { data, error } = useWorkspaceResource<{ name: string; enabled: boolean; configured: boolean }[]>(profile, 'toolsets');
  const [url, setUrl] = useState('');
  const [requestError, setRequestError] = useState('');
  const browser = data?.find(item => item.name === 'browser');
  const current = agent?.id === profile ? agent : agents.find(item => item.id === profile);
  const browse = async () => {
    try {
      const parsed = new URL(url);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Enter an HTTP or HTTPS URL without embedded credentials.');
      setRequestError(''); setActiveNav('chat');
      await sendMessage(`Use your browser tools to open ${parsed.href} and summarize what you find. Ask me for any required approval.`);
    } catch (error) { setRequestError(errorText(error)); }
  };

  const footer = (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-ink">Ask the bot to browse</p>
      <div className="flex items-center gap-2">
        <input
          className={`${inputClass} min-w-0 flex-1`}
          value={url}
          onChange={event => setUrl(event.target.value)}
          placeholder="https://example.com"
          aria-label="Website URL"
        />
        <button
          className={`${buttonClass} shrink-0 px-3`}
          disabled={isLoading || isPreparing || !activeSessionId || sessions.find(item => item.id === activeSessionId)?.readOnly || !url.trim() || browser?.enabled === false}
          onClick={browse}
        >
          Browse
        </button>
      </div>
      {(error || requestError) && <Notice error>{error || requestError}</Notice>}
      {browser && (!browser.enabled || !browser.configured) && (
        <p className="text-[11px] text-muted">
          Browser tools: <span className="font-medium text-ink">{browser.enabled ? 'Enabled' : 'Disabled'}</span>
          {' · '}
          <span className="font-medium text-ink">{browser.configured ? 'Configured' : 'Setup required'}</span>
        </p>
      )}
      <p className="text-[10px] leading-relaxed text-muted">Sends a message; the page opens when the bot acts.</p>
    </div>
  );

  return (
    <BrowserViewer
      profile={profile}
      botName={current?.name}
      avatarUrl={current?.avatarUrl}
      footer={footer}
    />
  );
}

export function HermesWorkspace({ page }: { page: string }) {
  const { agent, agents, selectAgent, isPreparing } = useChat();
  const [error, setError] = useState('');
  if (!agent) return <div className="space-y-3"><Skeleton className="h-9 w-full" /><Skeleton className="h-40 w-full" /></div>;
  return <div className="space-y-5"><Field label="Bot"><select className={inputClass} value={agent.id} disabled={isPreparing} onChange={event => { setError(''); void selectAgent(event.target.value, { stayOnPage: true }).catch(error => setError(errorText(error))); }}>{agents.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>{error && <Notice error>{error}</Notice>}{page === 'goals' ? <HermesGoals key={agent.id} profile={agent.id} /> : page === 'library' ? <HermesLibrary key={agent.id} profile={agent.id} /> : <HermesWorkshop key={agent.id} profile={agent.id} />}</div>;
}

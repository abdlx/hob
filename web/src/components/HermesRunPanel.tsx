import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../services/api';
import { buttonClass, inputClass, Notice } from './WorkspaceUI';
import { errorText } from './workspaceUtils';
import { Check, MessageCircle, Square } from 'lucide-react';
import { StatusPill } from './WorkspaceUI';

interface Question { id: string; generation: number; question: string; choices: string[]; multiSelect: boolean }
interface Run { runId: string | null; status: string; submittedAt: string; revision: string; canRecover: boolean; canResolveUnknown: boolean; questions: Question[] }

function Clarification({ question, busy, answer }: { question: Question; busy: boolean; answer: (value: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const submit = () => answer(question.multiSelect
    ? JSON.stringify([...selected, ...(text.trim() ? [text] : [])]) : text);
  return <section aria-label="Your input needed" className="space-y-3 rounded-2xl bg-surface border border-accent-line p-4 shadow-xs">
    <div className="flex items-center gap-2 text-xs font-semibold text-accent"><MessageCircle size={15} />Your input needed</div>
    <h3 className="text-sm font-medium leading-relaxed text-ink">{question.question}</h3>
    {question.choices.length > 0 && <div role="group" aria-label="Answer choices" className="grid gap-2 sm:grid-cols-2">{question.choices.map((choice, index) => {
      const chosen = question.multiSelect ? selected.includes(choice) : text === choice;
      return <button key={index} className={`flex min-h-11 items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left text-xs leading-relaxed transition-colors disabled:opacity-50 cursor-pointer ${chosen ? 'border-accent-line bg-accent-soft text-accent' : 'border-edge bg-canvas text-code hover:border-accent-line hover:bg-hover'}`} aria-pressed={chosen} disabled={busy} onClick={() => {
        if (question.multiSelect) setSelected(previous => previous.includes(choice) ? previous.filter(item => item !== choice) : [...previous, choice]);
        else setText(choice);
      }}><span className="min-w-0 break-words">{choice}</span><span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${chosen ? 'border-accent bg-accent text-canvas' : 'border-edge'}`}>{chosen && <Check size={10} />}</span></button>;
    })}</div>}
    <textarea className={inputClass} aria-label="Answer Hermes question" placeholder={question.multiSelect ? 'Add any details (optional)' : 'Choose an option or write your answer…'} value={text} maxLength={16384} rows={2} disabled={busy} onChange={event => setText(event.target.value)} onKeyDown={event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229 && (text.trim() || selected.length)) { event.preventDefault(); submit(); }
    }} />
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-[11px] text-muted">{question.multiSelect ? 'Choose any that apply, then send.' : 'Your choice is sent when you confirm.'}</p><button className={buttonClass} disabled={busy || (!text.trim() && !selected.length)} onClick={submit}>{busy ? 'Sending…' : 'Send answer'}</button></div>
  </section>;
}

// Mounted with the conversation ID as React's key so late requests cannot
// populate the controls of a different conversation or bot.
export function HermesRunPanel({ sessionId, inline = false }: { sessionId: string; inline?: boolean }) {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmedRevision, setConfirmedRevision] = useState('');
  const alive = useRef(true);
  const pending = useRef(false), loadSequence = useRef(0);
  const root = `/api/sessions/${encodeURIComponent(sessionId)}`;
  const load = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++loadSequence.current;
    try {
      const result = await apiFetch<{ run: Run | null }>(`${root}/run`, { signal });
      if (alive.current && sequence === loadSequence.current) { setRun(result.run); setError(''); }
    } catch (error) { if (alive.current && sequence === loadSequence.current && !signal?.aborted) setError(errorText(error)); }
  }, [root]);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    const initial = window.setTimeout(() => { void load(controller.signal); }, 0);
    const timer = window.setInterval(() => { if (!pending.current) void load(controller.signal); }, 3000);
    return () => { alive.current = false; controller.abort(); window.clearTimeout(initial); window.clearInterval(timer); };
  }, [load]);
  async function control(action: string, body: unknown) {
    if (pending.current) return;
    pending.current = true; loadSequence.current++;
    setBusy(true); setError('');
    try {
      await apiFetch(`${root}/${action}`, { method: 'POST', body: JSON.stringify(body) });
      if (alive.current) { setConfirmedRevision(''); await load(); }
    } catch (error) { if (alive.current) setError(errorText(error)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  const hasInlinePrompt = Boolean(run?.questions?.length || run?.status === 'waiting_for_approval' || (run && ['unknown', 'admitting', 'unavailable'].includes(run.status)));
  if (!run && !error) return null;
  const active = run && ['queued', 'running', 'waiting_for_approval', 'stopping'].includes(run.status);
  if (inline && !error && !hasInlinePrompt && !active) return null;
  const unknown = run && ['unknown', 'admitting', 'unavailable'].includes(run.status);
  return <div className={inline ? 'hob-chat-prompt my-3 w-full max-w-full space-y-3 text-xs md:text-sm sm:max-w-[92%]' : 'px-5 py-2.5 space-y-2.5 text-xs md:text-sm'}>
    {error && <Notice error>{error}</Notice>}
    {run && !inline && <div className="flex items-center justify-between gap-3 text-muted">
      <span className="font-medium capitalize">Run: {run.status.replaceAll('_', ' ')}</span>
      <div className="flex gap-2"><button className={buttonClass} disabled={busy} onClick={() => load()}>Refresh status</button>
        {active && <button className={buttonClass} disabled={busy || run.status === 'stopping'} onClick={() => control('abort', { expectedRunId: run.runId })}>Stop run</button>}</div>
    </div>}
    {inline && active && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hair bg-panel px-3 py-2" aria-label="Current run"><StatusPill status={run.status} /><button type="button" className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted transition-colors hover:bg-neutral hover:text-ink disabled:opacity-50 cursor-pointer" disabled={busy || run.status === 'stopping' || !run.runId} onClick={() => control('abort', { expectedRunId: run.runId })}><Square size={12} />{run.status === 'stopping' ? 'Stopping…' : 'Stop run'}</button></div>}
    {run?.questions?.map(question => <Clarification key={`${question.id}:${question.generation}`} question={question} busy={busy}
      answer={answer => control('clarify', { promptId: question.id, expectedRevision: run.revision, answer })} />)}
    {inline && run?.status === 'waiting_for_approval' && !run.questions.length && <Notice>Permission is required before Hermes can continue. Review the permission request in this conversation.</Notice>}
    {unknown && <Notice>
      {run.runId ? 'Hermes has not confirmed this run’s outcome. Review its history and any possible side effects before resolving it.'
        : 'Acceptance of this submission is unknown. Recovery uses the original request key and may start the original work if Hermes never accepted it. Nothing is resubmitted automatically.'}
      {(run.canRecover || run.canResolveUnknown) ? <div className="mt-2 space-y-2">
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirmedRevision === run.revision} disabled={busy} onChange={event => setConfirmedRevision(event.target.checked ? run.revision : '')} />
          <span>{run.canResolveUnknown ? 'I reviewed possible side effects and want to resolve this unknown work.' : 'I understand recovery may start the original submission.'}</span></label>
        <button className={buttonClass} disabled={busy || confirmedRevision !== run.revision} onClick={() => control(run.canResolveUnknown ? 'resolve-unknown' : 'recover',
          run.canResolveUnknown ? { confirmReviewed: true, expectedRevision: run.revision } : { confirmDispatch: true, expectedRevision: run.revision })}>{run.canResolveUnknown ? 'Resolve unknown work' : 'Recover original submission'}</button>
      </div> : <p className="mt-2">Safe recovery is currently unavailable. Inspect history and refresh status; a missing record is not proof that work stopped.</p>}
    </Notice>}
  </div>;
}

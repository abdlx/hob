import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../services/api';
import { buttonClass, inputClass, Notice } from './WorkspaceUI';
import { errorText } from './workspaceUtils';

interface Question { id: string; generation: number; question: string; choices: string[]; multiSelect: boolean }
interface Run { runId: string | null; status: string; submittedAt: string; revision: string; canRecover: boolean; canResolveUnknown: boolean; questions: Question[] }

function Clarification({ question, busy, answer }: { question: Question; busy: boolean; answer: (value: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  return <div className="space-y-2 rounded-xl border border-[#3a3126] p-3">
    <p className="text-[#dfd1bd]">{question.question}</p>
    {question.choices.length > 0 && <div className="flex flex-wrap gap-2">{question.choices.map((choice, index) =>
      <button key={index} className={buttonClass} aria-pressed={question.multiSelect ? selected.includes(choice) : text === choice} disabled={busy} onClick={() => {
        if (question.multiSelect) setSelected(previous => previous.includes(choice) ? previous.filter(item => item !== choice) : [...previous, choice]);
        else setText(choice);
      }}>{choice}</button>)}</div>}
    <textarea className={inputClass} aria-label="Answer Hermes question" value={text} maxLength={16384} rows={2} disabled={busy} onChange={event => setText(event.target.value)} />
    <button className={buttonClass} disabled={busy || (!text.trim() && !selected.length)} onClick={() => answer(question.multiSelect
      ? JSON.stringify([...selected, ...(text.trim() ? [text] : [])]) : text)}>Send answer</button>
  </div>;
}

// Mounted with the conversation ID as React's key so late requests cannot
// populate the controls of a different conversation or bot.
export function HermesRunPanel({ sessionId }: { sessionId: string }) {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmedRevision, setConfirmedRevision] = useState('');
  const alive = useRef(true);
  const root = `/api/sessions/${encodeURIComponent(sessionId)}`;
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await apiFetch<{ run: Run | null }>(`${root}/run`, { signal });
      if (alive.current) { setRun(result.run); setError(''); }
    } catch (error) { if (alive.current && !signal?.aborted) setError(errorText(error)); }
  }, [root]);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    const initial = window.setTimeout(() => { void load(controller.signal); }, 0);
    const timer = window.setInterval(() => { void load(controller.signal); }, 3000);
    return () => { alive.current = false; controller.abort(); window.clearTimeout(initial); window.clearInterval(timer); };
  }, [load]);
  async function control(action: string, body: unknown) {
    setBusy(true); setError('');
    try {
      await apiFetch(`${root}/${action}`, { method: 'POST', body: JSON.stringify(body) });
      if (alive.current) { setConfirmedRevision(''); await load(); }
    } catch (error) { if (alive.current) setError(errorText(error)); }
    finally { if (alive.current) setBusy(false); }
  }
  if (!run && !error) return null;
  const active = run && ['queued', 'running', 'waiting_for_approval', 'stopping'].includes(run.status);
  const unknown = run && ['unknown', 'admitting', 'unavailable'].includes(run.status);
  return <div className="px-5 py-2.5 space-y-2.5 text-xs md:text-sm">
    {error && <Notice error>{error}</Notice>}
    {run && <div className="flex items-center justify-between gap-3 text-[#c0b3a1]">
      <span className="font-medium capitalize">Run: {run.status.replaceAll('_', ' ')}</span>
      <div className="flex gap-2"><button className={buttonClass} disabled={busy} onClick={() => load()}>Refresh status</button>
        {active && <button className={buttonClass} disabled={busy || run.status === 'stopping'} onClick={() => control('abort', { expectedRunId: run.runId })}>Stop run</button>}</div>
    </div>}
    {run?.questions?.map(question => <Clarification key={`${question.id}:${question.generation}`} question={question} busy={busy}
      answer={answer => control('clarify', { promptId: question.id, expectedRevision: run.revision, answer })} />)}
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

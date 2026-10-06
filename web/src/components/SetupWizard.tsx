import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../services/api';
import { useChat } from '../context/ChatContext';
import { MarkdownView } from './MarkdownView';
import { buttonClass, cardClass, inputClass, Notice } from './WorkspaceUI';
import { errorText } from './workspaceUtils';
import { requestId } from '../services/id';

interface Step { id: string; type: string; title?: string; message?: string; options?: { label: string; value: unknown; hint?: string }[]; initialValue?: unknown; placeholder?: string; sensitive?: boolean; externalUrl?: string; deviceCode?: { code: string; message?: string } }
interface WizardResult { sessionId?: string; done: boolean; status?: string; error?: string; step?: Step }
export function SetupWizard({ flow = 'setup', authChoice }: { flow?: 'setup' | 'channels'; authChoice?: string }) {
  const { refresh, agent } = useChat();
  const [sessionId, setSessionId] = useState('');
  const [result, setResult] = useState<WizardResult | null>(null);
  const [answer, setAnswer] = useState<unknown>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cancelWaiting, setCancelWaiting] = useState(false);
  const activeSession = useRef('');
  useEffect(() => () => { if (activeSession.current) void apiFetch('/api/rpc', { method: 'POST', body: JSON.stringify({ method: 'wizard.cancel', params: { sessionId: activeSession.current, closeInput: true } }) }).catch(() => undefined); }, []);
  const call = async (method: string, params: Record<string, unknown>) => {
    setBusy(true); setError('');
    try {
      const next = await apiFetch<WizardResult>('/api/rpc', { method: 'POST', body: JSON.stringify({ method, params }) });
      const terminal = Boolean(next.done) || ['done', 'cancelled', 'error'].includes(next.status || '');
      // Cancellation may be refused while OpenClaw applies a protected change.
      // Retain the owning session until the gateway reports its terminal status.
      if (method === 'wizard.cancel') setCancelWaiting(!terminal);
      if (next.sessionId) { setSessionId(next.sessionId); activeSession.current = next.sessionId; }
      setResult({ ...next, done: terminal });
      setAnswer(next.step?.initialValue ?? (next.step?.type === 'multiselect' ? [] : next.step?.type === 'confirm' ? false : next.step?.type === 'select' ? next.step.options?.[0]?.value : ''));
      if (terminal) { activeSession.current = ''; setCancelWaiting(false); await refresh(); }
    } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  };
  const step = result?.step;
  const answerRequired = step && step.type !== 'progress';
  return <div className={`${cardClass} space-y-3`}><h3 className="text-[13px] text-[#d8c6aa]">{authChoice ? 'Provider sign-in' : flow === 'channels' ? 'Guided channel setup' : 'Guided OpenClaw setup'}</h3>{error && <Notice error>{error}</Notice>}{!sessionId || result?.done ? <><p className="text-[11px] text-[#8c8173]">Complete OpenClaw's guided configuration directly in this interface.</p><button disabled={busy} className={buttonClass} onClick={() => authChoice ? call('models.authLogin', { sessionId: requestId(), authChoice, agentId: agent?.id }) : call('wizard.start', { flow, mode: 'local', installDaemon: false })}>{result?.done ? 'Start setup again' : 'Start guided setup'}</button>{result?.done && <Notice error={Boolean(result.error)}>Setup {result.status || 'completed'}{result.error ? `: ${result.error}` : '.'}</Notice>}</> : <><div className="flex justify-between gap-3"><span className="text-[12px] text-[#cdbda5]">{step?.title || 'Setup in progress'}</span><button disabled={busy} className={buttonClass} onClick={() => call('wizard.cancel', { sessionId })}>Cancel</button></div>{cancelWaiting && <Notice>OpenClaw is still applying this step. Keep this session open, check progress, then retry Cancel.</Notice>}{result?.error && <Notice error>{result.error}</Notice>}{step?.message && <MarkdownView content={step.message} />}{step?.deviceCode && <Notice><span className="font-mono text-base text-[#d9c39f] select-text">{step.deviceCode.code}</span><br />{step.deviceCode.message}</Notice>}{step?.externalUrl && /^https?:\/\//i.test(step.externalUrl) && <a className={buttonClass} href={step.externalUrl} target="_blank" rel="noreferrer">Open sign-in page</a>}{step?.type === 'text' && <input aria-label={step.title || 'Setup input'} type={step.sensitive ? 'password' : 'text'} className={inputClass} value={String(answer ?? '')} placeholder={step.placeholder} onChange={(event) => setAnswer(event.target.value)} />}{step?.type === 'select' && <select aria-label={step.title || 'Setup option'} className={inputClass} value={JSON.stringify(answer)} onChange={(event) => setAnswer(JSON.parse(event.target.value))}>{step.options?.map((option) => <option key={JSON.stringify(option.value)} value={JSON.stringify(option.value)}>{option.label}{option.hint ? ` · ${option.hint}` : ''}</option>)}</select>}{step?.type === 'confirm' && <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={Boolean(answer)} onChange={(event) => setAnswer(event.target.checked)} />Confirm</label>}{step?.type === 'multiselect' && step.options?.map((option) => <label key={JSON.stringify(option.value)} className="flex items-start gap-2 text-[12px]"><input type="checkbox" checked={Array.isArray(answer) && answer.some((item) => JSON.stringify(item) === JSON.stringify(option.value))} onChange={(event) => setAnswer((previous: unknown) => event.target.checked ? [...(Array.isArray(previous) ? previous : []), option.value] : (Array.isArray(previous) ? previous : []).filter((item) => JSON.stringify(item) !== JSON.stringify(option.value)))} /><span>{option.label}{option.hint && <span className="block text-[10px] text-[#867a69]">{option.hint}</span>}</span></label>)}<button disabled={busy} className={buttonClass} onClick={() => call('wizard.next', { sessionId, ...(step && answerRequired ? { answer: { stepId: step.id, value: ['text', 'select', 'multiselect', 'confirm'].includes(step.type) ? answer : undefined } } : {}) })}>{step?.type === 'progress' || !step ? 'Check progress' : 'Continue'}</button></>}{busy && <Notice>Waiting for OpenClaw setup…</Notice>}</div>;
}

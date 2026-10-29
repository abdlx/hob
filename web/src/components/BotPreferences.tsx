import { useEffect, useMemo, useRef, useState } from 'react';
import { hermesSetupApi } from '../services/hermes-setup';
import { buttonClass, cardClass, Field, inputClass, Notice, Skeleton } from './WorkspaceUI';
import { errorText } from './workspaceUtils';

interface Preferences { language: string; timezone: string; maxTurns: number | null; runBudgetSeconds: number | null }

export function BotPreferences({ profile }: { profile: string }) {
  const api = useMemo(() => hermesSetupApi(profile), [profile]);
  const [value, setValue] = useState<Preferences | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const sequence = useRef(0), pending = useRef(false);
  useEffect(() => {
    const reference = sequence;
    const current = ++reference.current;
    void api<Preferences>('preferences').then(result => { if (current === sequence.current) setValue(result); }).catch(cause => { if (current === sequence.current) setError(errorText(cause)); });
    return () => { reference.current++; };
  }, [api]);
  async function save() {
    if (!value || pending.current) return;
    const current = sequence.current; pending.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const result = await api<Preferences>('preferences', { method: 'PUT', body: JSON.stringify({ ...value, confirm: true }) });
      if (current === sequence.current) { setValue(result); setMessage('Preferences saved for this bot. Start a new conversation to adopt language and run limits. Check active schedules after changing timezone.'); }
    } catch (cause) { if (current === sequence.current) setError(errorText(cause)); }
    finally { pending.current = false; if (current === sequence.current) setBusy(false); }
  }
  return <section aria-label="Bot language and limits" className={`${cardClass} space-y-3`}><h3 className="text-sm font-semibold text-ink">Language, timezone & run limits</h3>
    {error && <Notice error>{error}</Notice>}{message && <Notice>{message}</Notice>}
    {!value && !error && <Skeleton className="h-32 w-full" />}
    {value && <><Field label="Reply and title language"><select className={inputClass} disabled={busy} value={value.language} onChange={event => setValue({ ...value, language: event.target.value })}><option value="auto">Follow the current conversation</option><option value="en">English</option><option value="ur-Latn">Roman Urdu</option><option value="ur">Urdu</option><option value="mixed">Match mixed-language conversation</option></select></Field>
      <Field label="Bot timezone" hint="Use an IANA timezone. An empty value uses the server's timezone."><input className={inputClass} disabled={busy} value={value.timezone} placeholder="Asia/Karachi" onChange={event => setValue({ ...value, timezone: event.target.value })} /></Field>
      <Field label="Maximum model turns per run" hint="Native Hermes iteration cap. Empty means unlimited."><input type="number" min={1} max={1000} className={inputClass} disabled={busy} value={value.maxTurns ?? ''} onChange={event => setValue({ ...value, maxTurns: event.target.value === '' ? null : Number(event.target.value) })} /></Field>
      <Field label="Run time budget (seconds)" hint="Native wall-clock budget. In-flight provider requests may take time to settle. Empty means unlimited."><input type="number" min={1} max={86400} className={inputClass} disabled={busy} value={value.runBudgetSeconds ?? ''} onChange={event => setValue({ ...value, runBudgetSeconds: event.target.value === '' ? null : Number(event.target.value) })} /></Field>
      <Notice>These are runtime limits, not a currency spending cap. Provider billing and background/delegated calls need separate accounting. Use provider-side spending limits when a strict financial cap is required.</Notice>
      <button className={buttonClass} disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save bot preferences'}</button>
    </>}
  </section>;
}

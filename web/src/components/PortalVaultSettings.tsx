import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, Loader2, RefreshCw } from 'lucide-react';
import { apiFetch } from '../services/api';
import { buttonClass, cardClass, ConfirmButton, Field, inputClass, Notice, Skeleton } from './WorkspaceUI';
import { errorText } from './workspaceUtils';
import { useToast } from '../context/ToastContext';

interface VaultBot { name: string; displayName: string }
interface VaultItem { id: string; name: string; origin: string; username: string; updatedAt: number }

export function PortalVaultSettings({ initialProfile }: { initialProfile: string }) {
  const [bots, setBots] = useState<VaultBot[]>([]);
  const [selected, setSelected] = useState(initialProfile);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError('');
    try {
      const result = await apiFetch<{ bots: VaultBot[] }>('/api/hermes/portal/vault/bots', { signal });
      if (signal?.aborted) return;
      setBots(result.bots);
      setSelected(current => result.bots.some(bot => bot.name === current) ? current : result.bots[0]?.name || '');
    } catch (cause) { if (!signal?.aborted) setError(errorText(cause)); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);
  return <div className="space-y-5">
    <section className={`${cardClass} space-y-3`}>
      <div className="flex items-center justify-between gap-3"><h3 className="flex items-center gap-2 text-sm font-semibold text-ink"><KeyRound size={16} />Computer vault</h3>
        <button type="button" className={buttonClass} disabled={loading} onClick={() => void load()} aria-label="Refresh computer bots"><RefreshCw size={14} /></button></div>
      {error && <Notice error>{error}</Notice>}
      {loading ? <Skeleton className="h-10 w-full" /> : bots.length ? <Field label="Bot" hint="Each bot has its own saved logins.">
        <select className={inputClass} value={selected} onChange={event => setSelected(event.target.value)}>{bots.map(bot => <option key={bot.name} value={bot.name}>{bot.displayName}</option>)}</select>
      </Field> : !error && <Notice>Assign a computer to a bot from its Computer tab to use its vault.</Notice>}
    </section>
    {!loading && !error && bots.some(bot => bot.name === selected) && <BotVault key={selected} profile={selected} />}
  </div>;
}

function BotVault({ profile }: { profile: string }) {
  const { toast } = useToast();
  const [items, setItems] = useState<VaultItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [origin, setOrigin] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const mounted = useRef(false);
  const pending = useRef(false);
  const base = '/api/hermes/portal/vault/items';
  const request = useCallback(<T,>(suffix = '', init: RequestInit = {}) => apiFetch<T>(`${base}${suffix}?profile=${encodeURIComponent(profile)}`, {
    ...init, headers: { 'X-Hob-Profile': profile },
  }), [profile]);
  const reload = useCallback(async (signal?: AbortSignal) => {
    const result = await request<{ items: VaultItem[] }>('', { signal });
    if (mounted.current && !signal?.aborted) setItems(result.items);
  }, [request]);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void reload(controller.signal).catch(cause => { if (!controller.signal.aborted) setError(errorText(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { mounted.current = false; controller.abort(); };
  }, [reload]);
  const perform = async (work: () => Promise<unknown>, message: string) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      await work();
      if (mounted.current) { toast(message); await reload(); }
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return <>
    <form className={`${cardClass} space-y-3`} onSubmit={event => {
      event.preventDefault();
      void perform(async () => {
        await request('', { method: 'POST', body: JSON.stringify({ name, origin, username, password }) });
        if (mounted.current) { setPassword(''); setName(''); setOrigin(''); setUsername(''); }
      }, 'Credential saved for this bot.');
    }}>
      <h3 className="text-sm font-semibold text-ink">Add credential</h3>
      <p className="text-xs text-muted">Saved logins are encrypted. The bot can autofill them on the matching site without receiving the password.</p>
      {error && <Notice error>{error}</Notice>}
      <fieldset disabled={busy || loading} className="space-y-3">
        <Field label="Name"><input className={inputClass} required maxLength={120} placeholder="Work email" value={name} onChange={event => setName(event.target.value)} /></Field>
        <Field label="Site URL" hint="Use the HTTPS address of the login site."><input className={inputClass} required type="url" placeholder="https://example.com" value={origin} onChange={event => setOrigin(event.target.value)} /></Field>
        <Field label="Username or email"><input className={inputClass} maxLength={320} autoComplete="off" value={username} onChange={event => setUsername(event.target.value)} /></Field>
        <Field label="Password"><input className={inputClass} required type="password" maxLength={16384} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} /></Field>
        <button className={buttonClass} type="submit" disabled={!name.trim() || !origin.trim() || !password}>{busy && <Loader2 size={14} className="animate-spin" />}Save credential</button>
      </fieldset>
    </form>
    <section className={`${cardClass} space-y-3`}>
      <h3 className="text-sm font-semibold text-ink">Saved credentials</h3>
      {loading ? <Skeleton className="h-20 w-full" /> : items.length ? items.map(item => <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border border-hair p-3">
        <div className="min-w-0"><p className="truncate text-sm text-ink">{item.name}</p><p className="break-all text-xs text-muted">{item.origin}</p>{item.username && <p className="break-all text-xs text-muted">{item.username}</p>}</div>
        <ConfirmButton className={`${buttonClass} shrink-0`} disabled={busy} tone="danger" confirmLabel="Remove" message="Remove this login from this bot's vault?" onConfirm={() => void perform(() => request('/' + encodeURIComponent(item.id), { method: 'DELETE' }), 'Credential removed.')}>Remove</ConfirmButton>
      </div>) : !error && <p className="text-xs text-muted">No credentials saved for this bot.</p>}
    </section>
  </>;
}


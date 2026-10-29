import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, KeyRound, Plug, Search, ShieldCheck } from 'lucide-react';
import { apiFetch } from '../services/api';
import { buttonClass, inputClass, Notice, Skeleton } from './WorkspaceUI';
import { errorText } from './workspaceUtils';

interface Connection { id: string; provider: string; name: string; sourceProfile: string; sourceName: string; configured: boolean; verifiedAt: string | null }
interface Inventory { connections: Connection[]; unavailableProfiles: string[] }

export function HermesSavedProviders({ profile, botName, revision, busy, onConnected, onChooseModel }: {
  profile: string; botName: string; revision: number; busy: boolean; onConnected: () => Promise<void>; onChooseModel: (provider: string) => void;
}) {
  const [inventory, setInventory] = useState<Inventory | null>(null), [error, setError] = useState('');
  const [pending, setPending] = useState(''), [search, setSearch] = useState(''), [message, setMessage] = useState('');
  const sequence = useRef(0), operation = useRef(false), alive = useRef(true);
  const invalidate = useCallback(() => { sequence.current++; }, []);
  const endpoint = `/api/hermes/saved-providers?profile=${encodeURIComponent(profile)}`;
  const load = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const result = await apiFetch<Inventory>(endpoint, { headers: { 'X-Hob-Profile': profile } });
      if (alive.current && sequence.current === current) { setInventory(result); setError(''); }
    } catch (error) { if (alive.current && sequence.current === current) setError(errorText(error)); }
  }, [endpoint, profile]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; invalidate(); }; }, [invalidate]);
  useEffect(() => { const timer = window.setTimeout(load, 0); return () => { window.clearTimeout(timer); invalidate(); }; }, [load, revision, invalidate]);
  async function act(connection: Connection, action: 'connect' | 'verify') {
    if (operation.current) return;
    operation.current = true; setPending(connection.id); setError(''); setMessage('');
    try {
      const result = await apiFetch<{ ok?: boolean; message?: string }>(endpoint, { method: 'POST', headers: { 'X-Hob-Profile': profile }, body: JSON.stringify({ id: connection.id, action }) });
      if (!alive.current) return;
      if (result.ok !== true) throw new Error('The provider operation was not confirmed. Refresh providers before retrying.');
      setMessage(action === 'connect' ? `${connection.name} connected to ${botName}. Choose its model below when you are ready.` : result.message || 'Verification finished.');
      await load();
      if (action === 'connect') await onConnected();
    } catch (error) { if (alive.current) setError(errorText(error)); }
    finally { operation.current = false; if (alive.current) setPending(''); }
  }
  const matches = inventory?.connections.filter(item => `${item.name} ${item.sourceName}`.toLowerCase().includes(search.trim().toLowerCase())) || [];
  return <section aria-label="Saved providers" className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-semibold text-ink">Saved providers</h2><p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">Reuse a saved API key with {botName}. Connecting keeps the current model selection. Keys stay private.</p></div><button className={buttonClass} disabled={busy || Boolean(pending)} onClick={load}>Refresh providers</button></div>
    {error && <Notice error>{error}</Notice>}
    {message && <p role="status" className="rounded-xl bg-accent-soft p-3 text-xs text-ink">{message}</p>}
    {inventory?.unavailableProfiles.length ? <Notice>Some saved connections could not be loaded: {inventory.unavailableProfiles.join(', ')}. Refresh to try again.</Notice> : null}
    {!inventory && !error && <Skeleton className="h-32 w-full" />}
    {inventory && <>
      {inventory.connections.length > 4 && <div className="relative"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><input className={`${inputClass} pl-9`} aria-label="Search saved providers" placeholder="Find a provider or bot" value={search} onChange={event => setSearch(event.target.value)} /></div>}
      {matches.length ? <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-3">{matches.map(connection => <article key={connection.id} aria-label={`${connection.name} saved in ${connection.sourceName}`} className="flex min-w-0 flex-col rounded-2xl border border-hair bg-surface p-4 shadow-xs">
        <div className="mb-4 flex items-start gap-3"><span className="rounded-xl bg-accent-soft p-2.5 text-accent"><Plug size={20} /></span><div className="min-w-0"><h3 className="truncate text-sm font-semibold text-ink">{connection.name}</h3><p className="mt-1 truncate text-xs text-muted">Saved in {connection.sourceName}</p></div></div>
        <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px]"><span className="inline-flex items-center gap-1 text-soft"><KeyRound size={12} /> Key stored</span>{connection.verifiedAt ? <span title={`Checked ${new Date(connection.verifiedAt).toLocaleString()}`} className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-1 text-accent"><ShieldCheck size={12} /> Verified recently</span> : <span className="rounded-full bg-hover px-2 py-1 text-muted">Not verified recently</span>}</div>
        <div className="mt-auto flex flex-wrap items-center gap-2"><button className={`${buttonClass} inline-flex items-center gap-1.5`} disabled={busy || Boolean(pending) || connection.configured} onClick={() => act(connection, 'connect')}>{connection.configured ? <><Check size={13} /> Configured for {botName}</> : pending === connection.id ? 'Working…' : `Connect to ${botName}`}</button>{connection.configured && <button className={buttonClass} disabled={busy || Boolean(pending)} onClick={() => onChooseModel(connection.provider)}>Choose model</button>}<button className="px-1 py-2 text-xs text-muted hover:text-ink disabled:opacity-50" disabled={busy || Boolean(pending)} onClick={() => act(connection, 'verify')}>Verify key</button></div>
      </article>)}</div> : <div className="rounded-2xl border border-dashed border-hair p-6 text-center"><KeyRound size={22} className="mx-auto mb-2 text-muted" /><p className="text-sm text-ink">{search ? 'No matching providers' : 'No saved API-key providers yet'}</p><p className="mt-1 text-xs text-muted">{search ? 'Try another provider or bot name.' : 'Save a provider key below. It will appear here for your other bots.'}</p></div>}
      <p className="text-[11px] leading-relaxed text-muted">Each bot keeps its own copy. Replacing a key on one bot does not update other bots. OAuth accounts and custom endpoints use their setup forms below.</p>
    </>}
  </section>;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Package, RefreshCw, Search } from 'lucide-react';
import { hermesSetupApi } from '../services/hermes-setup';
import { pluginResultMessage } from '../services/hermes-plugins';
import type { PluginEntry, PluginInventory, PluginOperation, PluginResult, PluginStoreItem } from '../services/hermes-plugins';
import { buttonClass, cardClass, inputClass, Notice, Skeleton, StatusPill } from './WorkspaceUI';
import { PluginAppIcon, PluginDetailsModal } from './PluginDetailsModal';
import { errorText } from './workspaceUtils';

export function HermesPluginsSettings({ profile }: { profile: string }) {
  // The installed Hermes dashboard cannot bind plugin writes to a named bot.
  return profile === 'default' ? <PluginCatalog /> : <section className={`${cardClass} space-y-2`}><h3 className="text-sm font-semibold text-ink">Native plugins</h3><Notice>This Hermes version manages plugins for Main only. Select Main to open its catalog. MCP connections below and skills belong to this selected bot.</Notice></section>;
}

function PluginCatalog() {
  const [inventory, setInventory] = useState<PluginInventory | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<PluginResult | null>(null);
  const [busy, setBusy] = useState('');
  const [consent, setConsent] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [feedbackName, setFeedbackName] = useState<string | null>(null);
  const pending = useRef(false), mounted = useRef(false), sequence = useRef(0);
  const invalidate = useCallback(() => { sequence.current++; }, []);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    const value = await hermesSetupApi('default')<PluginInventory>('plugins');
    if (mounted.current && current === sequence.current) setInventory(value);
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load().catch(cause => { if (mounted.current) setError(errorText(cause)); });
    return () => { mounted.current = false; invalidate(); };
  }, [load, invalidate]);
  const act = async (name: string, operation: PluginOperation, entry?: PluginEntry, acceptCapabilities = false) => {
    if (pending.current) return;
    pending.current = true; setFeedbackName(name); setBusy(`${operation}:${name}`); setError(''); setMessage(''); setResult(null); setConsent(null);
    try {
      const value = await hermesSetupApi('default')<PluginResult>(`plugins/${encodeURIComponent(name)}/${operation}`, {
        method: 'POST', body: JSON.stringify({ confirm: true, ...(entry ? { expectedSha: entry.sha } : {}), ...(operation === 'update' ? { acceptCapabilities } : {}) }),
      });
      const text = pluginResultMessage(operation, value);
      if (!mounted.current) return;
      setMessage(text); setResult(value);
      if (value.consent_required) setConsent(name);
      try { await load(); } catch { if (mounted.current) setError('The operation returned, but the inventory could not be refreshed. Refresh before taking another action.'); }
    } catch (cause) {
      if (mounted.current) setError(errorText(cause));
      // Observe after uncertain completion; never automatically replay a write.
      try { await load(); } catch { /* Preserve the mutation error. */ }
    } finally { pending.current = false; if (mounted.current) setBusy(''); }
  };
  const items = new Map<string, PluginStoreItem>();
  for (const entry of inventory?.entries || []) items.set(entry.name, { name: entry.name, entry });
  for (const installed of inventory?.installed || []) items.set(installed.name, { ...items.get(installed.name), name: installed.name, installed });
  for (const removed of inventory?.removed || []) {
    const item = items.get(removed.name);
    if (item) item.removedReason = removed.reason;
  }
  const query = search.trim().toLowerCase();
  const entries = [...items.values()].filter(({ name, entry, installed }) => {
    const searchable = [name, entry?.description, installed?.description, entry?.maintainer, ...(entry?.capabilities.provides_tools || [])].join(' ').toLowerCase();
    const matchesFilter = filter === 'all' || (filter === 'installed' ? !!installed || entry?.installed : entry?.tier === filter);
    return searchable.includes(query) && matchesFilter;
  });
  const selected = selectedName ? items.get(selectedName) : undefined;
  const feedback = <>
    {error && <Notice error>{error}</Notice>}
    {message && <Notice>{message}</Notice>}
    {!!busy && <p role="status" aria-live="polite" className="text-xs text-accent">Hermes is processing {busy.replace(':', ' for ')}. This may take several minutes. The inventory will refresh when it returns.</p>}
    {result && <div className="space-y-2">{result.warnings?.map((warning, index) => <Notice key={index}>{warning}</Notice>)}
      {!!result.missing_env?.length && <Notice>Required credentials: {result.missing_env.join(', ')}. Save them under Models &amp; providers before enabling.</Notice>}
      {consent && <div className="space-y-3 rounded-xl border border-edge bg-panel p-3"><p className="text-xs text-soft">Additional capabilities requested by {consent}:</p><ul className="list-disc pl-5 text-xs text-muted">{result.delta_lines?.map((line, index) => <li key={index}>{line}</li>)}</ul><button className={buttonClass} disabled={!!busy || !result.delta_lines?.length} onClick={() => void act(consent, 'update', undefined, true)}>Accept listed capabilities and update</button></div>}
    </div>}
  </>;
  const gridClass = 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,140px),1fr))] gap-3';
  return <section className={`${cardClass} space-y-5`} aria-label="Plugin store">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2.5"><span className="rounded-xl bg-accent-soft p-2 text-accent"><Package size={19} /></span><div><h3 className="text-base font-semibold tracking-tight text-ink">Plugin store</h3><p className="mt-0.5 text-xs text-muted">Discover apps and tools for Main.</p></div></div>
      <button className={buttonClass} disabled={!!busy} onClick={() => { setError(''); void load().catch(cause => setError(errorText(cause))); }}><RefreshCw size={13} />Refresh catalog</button>
    </div>
    {!selected && feedback}
    {!inventory && !error ? <div className={gridClass}>{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-52 w-full rounded-2xl" />)}</div> : inventory && <>
      <div className="flex flex-col gap-2 sm:flex-row"><div className="relative min-w-0 flex-1"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><input aria-label="Search plugin catalog" className={`${inputClass} pl-9`} placeholder="Search apps, publishers or tools..." value={search} onChange={event => setSearch(event.target.value)} /></div><select aria-label="Filter plugins" className={`${inputClass.replace('w-full ', '')} w-full shrink-0 sm:w-36`} value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All apps</option><option value="official">Official</option><option value="verified">Verified</option><option value="community">Community</option><option value="installed">Installed</option></select></div>
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted"><span aria-live="polite">{entries.length} {entries.length === 1 ? 'app' : 'apps'}{query ? ' found' : ' to explore'}</span><span>{inventory.installed.length} installed</span></div>
      <div className={gridClass} role="list" aria-label="Plugin apps">
        {entries.map(plugin => {
          const { name, entry, installed } = plugin;
          const isInstalled = !!installed || entry?.installed === true;
          return <div key={name} role="listitem" className="min-w-0"><button type="button" aria-label={`View ${name} details`} aria-haspopup="dialog" disabled={!!busy} onClick={() => setSelectedName(name)}
            className="group flex h-full min-h-56 w-full flex-col items-start rounded-2xl border border-line bg-surface p-4 text-left transition-all hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60 cursor-pointer">
            <div className="mb-4 flex w-full items-start justify-between gap-2"><PluginAppIcon name={name} /><ArrowUpRight size={15} className="mt-1 text-faint transition-colors group-hover:text-accent" /></div>
            <span className="max-w-full break-words text-sm font-semibold text-ink">{name}</span>
            <span className="mt-1 max-w-full truncate text-[11px] text-muted">{entry?.maintainer || installed?.source || 'Installed app'}</span>
            <span className="mt-2 mb-4 line-clamp-2 break-words text-xs leading-relaxed text-soft">{entry?.description || installed?.description || 'Open this app to see its details.'}</span>
            <span className="mt-auto flex w-full flex-wrap items-center gap-2">{isInstalled ? <StatusPill status={installed?.runtime_status || entry?.runtime_status || 'installed'} /> : <span className="rounded-full bg-panel px-2 py-1 text-[10px] capitalize text-muted">{entry?.tier || 'Catalog'}</span>}{entry?.update_available && <span className="text-[10px] font-medium text-accent">Update available</span>}</span>
          </button></div>;
        })}
      </div>
      {entries.length === 0 && <div className="rounded-2xl border border-dashed border-edge py-10 text-center"><Package size={24} className="mx-auto mb-3 text-faint" /><p className="text-sm font-medium text-ink">No apps found</p><p className="mt-1 text-xs text-muted">Try a different search or filter.</p></div>}
    </>}
    {selected && <PluginDetailsModal key={selected.name} plugin={{ ...selected, removedReason: selected.removedReason || selected.installed?.removed_reason }} busy={!!busy}
      feedback={feedbackName === selected.name || !feedbackName ? feedback : null} onClose={() => setSelectedName(null)}
      onAction={(operation, acceptCapabilities) => { void act(selected.name, operation, operation === 'install' ? selected.entry : undefined, acceptCapabilities); }} />}
  </section>;
}

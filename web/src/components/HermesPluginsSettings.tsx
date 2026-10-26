import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Package, RefreshCw, Search } from 'lucide-react';
import { hermesSetupApi, setupLink } from '../services/hermes-setup';
import { pluginResultMessage } from '../services/hermes-plugins';
import type { PluginEntry, PluginInventory, PluginOperation, PluginResult } from '../services/hermes-plugins';
import { buttonClass, cardClass, ConfirmButton, inputClass, Notice, Skeleton, StatusPill } from './WorkspaceUI';
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
    pending.current = true; setBusy(`${operation}:${name}`); setError(''); setMessage(''); setResult(null); setConsent(null);
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
  const query = search.trim().toLowerCase();
  const entries = inventory?.entries.filter(entry => `${entry.name} ${entry.description} ${entry.maintainer} ${entry.capabilities.provides_tools.join(' ')}`.toLowerCase().includes(query) && (filter === 'all' || (filter === 'installed' ? entry.installed : entry.tier === filter))) ?? [];
  return <section className={`${cardClass} space-y-4`}>
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><Package size={17} className="text-muted" /><h3 className="text-sm font-semibold text-ink">Hermes plugin catalog</h3></div><button className={buttonClass} disabled={!!busy} onClick={() => { setError(''); void load().catch(cause => setError(errorText(cause))); }}><RefreshCw size={13} />Refresh catalog</button></div>
    <p className="text-xs leading-relaxed text-muted">Installs use Hermes’s native installer and reviewed commit pins for Main. Plugins may run code with the runtime’s access. Review their capabilities and requirements before installing.</p>
    {error && <Notice error>{error}</Notice>}
    {message && <Notice>{message}</Notice>}
    {!!busy && <p role="status" aria-live="polite" className="text-xs text-accent">Hermes is processing {busy.replace(':', ' for ')}. This may take several minutes. The installed inventory will be checked when it returns.</p>}
    {result && <div className="space-y-2">{result.warnings?.map((warning, index) => <Notice key={index}>{warning}</Notice>)}{!!result.missing_env?.length && <Notice>Required credentials: {result.missing_env.join(', ')}. Save them under Models & providers before enabling.</Notice>}
      {consent && <div className="space-y-3 rounded-lg border border-edge p-3"><p className="text-xs text-soft">Additional capabilities requested by {consent}:</p><ul className="list-disc pl-5 text-xs text-muted">{result.delta_lines?.map((line, index) => <li key={index}>{line}</li>)}</ul><button className={buttonClass} disabled={!!busy || !result.delta_lines?.length} onClick={() => void act(consent, 'update', undefined, true)}>Accept listed capabilities and update</button></div>}
    </div>}
    {!inventory && !error ? <Skeleton className="h-32 w-full" /> : inventory && <>
      <div className="flex gap-2"><div className="relative min-w-0 flex-1"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><input aria-label="Search plugin catalog" className={`${inputClass} pl-9`} placeholder="Search plugins or tools…" value={search} onChange={event => setSearch(event.target.value)} /></div><select aria-label="Filter plugins" className={`${inputClass.replace('w-full ', '')} w-36 shrink-0`} value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All sources</option><option value="official">Official</option><option value="verified">Verified</option><option value="community">Community</option><option value="installed">Installed</option></select></div>
      <div className="divide-y divide-hair">{entries.map(entry => <article key={entry.name} className="py-4 first:pt-1 space-y-2.5">
        <div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-semibold text-ink">{entry.name}</h4><span className="text-[10px] uppercase tracking-wide text-muted">{entry.tier} · {entry.maintainer}</span>{entry.installed && <StatusPill status={entry.runtime_status || 'installed'} />}</div>
        <p className="text-xs leading-relaxed text-soft">{entry.description}</p>
        <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px] text-muted">
          <dt>Commit</dt><dd className="font-mono break-all select-text">{entry.sha}</dd>
          <dt>Compatibility</dt><dd>{entry.requires_hermes || 'No minimum declared'} · {entry.platforms?.join(', ') || 'All platforms'}</dd>
          <dt>Capabilities</dt><dd className="break-words">{[...entry.capabilities.provides_tools, ...entry.capabilities.provides_hooks, ...entry.capabilities.provides_middleware].join(', ') || 'No tools, hooks or middleware declared'}</dd>
          <dt>Credentials</dt><dd className="break-words">{entry.capabilities.requires_env.join(', ') || 'None declared'}</dd>
        </dl>
        <div className="flex flex-wrap items-center gap-2">{!entry.installed && <ConfirmButton className={buttonClass} disabled={!!busy} confirmLabel="Install reviewed pin" message={`Install ${entry.name} at ${entry.sha.slice(0, 12)} for Main? Hermes validates the package and dependencies. It will stay disabled until you enable it.`} onConfirm={() => { void act(entry.name, 'install', entry); }}><Download size={13} />Install</ConfirmButton>}{entry.update_available && <span className="text-xs text-warn">New catalog pin available</span>}{setupLink(entry.docs_url || entry.repo) && <a className="text-xs text-accent hover:underline" href={setupLink(entry.docs_url || entry.repo)} target="_blank" rel="noreferrer">Source & documentation ↗</a>}</div>
      </article>)}</div>
      {entries.length === 0 && <p className="text-xs text-muted">No plugins match these filters.</p>}
      <div className="border-t border-hair pt-4 space-y-3"><h4 className="text-xs font-semibold text-ink">Installed plugins · Main</h4>{inventory.installed.length === 0 && <p className="text-xs text-muted">No installed plugins were reported by Hermes.</p>}{inventory.installed.map(plugin => <div key={plugin.name} className="rounded-lg border border-hair bg-panel p-3 space-y-2"><div className="flex flex-wrap items-center gap-2"><span className="text-xs font-medium text-ink">{plugin.name}</span><span className="text-[11px] text-muted">{plugin.version} · {plugin.source}</span><StatusPill status={plugin.runtime_status} /></div><p className="text-xs text-muted">{plugin.description}</p>{plugin.removed_reason && <Notice error>{plugin.removed_reason}</Notice>}{plugin.auth_required && <p className="text-xs text-warn">This plugin requires additional authentication. See its documentation.</p>}<div className="flex flex-wrap gap-2"><ConfirmButton className={buttonClass} disabled={!!busy || !!plugin.removed_reason} message={`${plugin.runtime_status === 'enabled' ? 'Disable' : 'Enable'} ${plugin.name} for Main? Enabled plugins can execute with Hermes’s access.`} confirmLabel="Confirm change" onConfirm={() => { void act(plugin.name, plugin.runtime_status === 'enabled' ? 'disable' : 'enable'); }}>{plugin.runtime_status === 'enabled' ? 'Disable' : 'Enable'}</ConfirmButton>{plugin.can_update_git && inventory.entries.some(entry => entry.name === plugin.name && entry.installed) && <button className={buttonClass} disabled={!!busy || !!plugin.removed_reason} onClick={() => void act(plugin.name, 'update')}>Update to catalog pin</button>}{plugin.can_remove && <ConfirmButton className={buttonClass} disabled={!!busy} tone="danger" message={`Remove ${plugin.name} from Main? Review plugin-owned data before removal.`} confirmLabel="Remove plugin" onConfirm={() => { void act(plugin.name, 'remove'); }}>Remove</ConfirmButton>}</div></div>)}</div>
    </>}
  </section>;
}

import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, Download, KeyRound, Package, Power, RefreshCw, Trash2, X } from 'lucide-react';
import { setupLink } from '../services/hermes-setup';
import type { PluginOperation, PluginStoreItem } from '../services/hermes-plugins';
import { buttonClass, dangerButtonClass, Notice, StatusPill } from './WorkspaceUI';

export function PluginAppIcon({ name, large = false }: { name: string; large?: boolean }) {
  const colors = ['bg-accent-soft text-accent', 'bg-ok-soft text-ok', 'bg-warn-soft text-warn', 'bg-neutral text-code'];
  const color = colors[Array.from(name).reduce((total, letter) => total + letter.charCodeAt(0), 0) % colors.length];
  const words = name.split(/[-_\s]+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
  return <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center border border-black/5 font-semibold tracking-tight ${color} ${large ? 'h-16 w-16 rounded-[20px] text-2xl' : 'h-12 w-12 rounded-2xl text-lg'}`}>{initials || <Package size={22} />}</span>;
}

function CapabilityList({ title, values }: { title: string; values: string[] }) {
  return <div className="space-y-2"><h3 className="text-xs font-semibold text-ink">{title}</h3>
    {values.length ? <div className="flex flex-wrap gap-1.5">{values.map(value => <span key={value} className="max-w-full break-all rounded-lg border border-line bg-panel px-2.5 py-1.5 font-mono text-[11px] text-soft">{value}</span>)}</div> : <p className="text-xs text-muted">None declared</p>}
  </div>;
}

export function PluginDetailsModal({ plugin, busy, feedback, onClose, onAction }: {
  plugin: PluginStoreItem; busy: boolean; feedback: ReactNode; onClose: () => void;
  onAction: (operation: PluginOperation, acceptCapabilities?: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const confirmationPanel = useRef<HTMLElement>(null);
  const titleId = useId(), descriptionId = useId();
  const [decision, setDecision] = useState<PluginOperation | null>(null);
  const { name, entry, installed, removedReason } = plugin;
  const isInstalled = !!installed || entry?.installed === true;
  const documentation = setupLink(entry?.docs_url), repository = setupLink(entry?.repo);
  const status = installed?.runtime_status || entry?.runtime_status || (isInstalled ? 'installed' : 'available');
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  useEffect(() => {
    if (decision) confirmationPanel.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [decision]);
  const confirmation = decision === 'install'
    ? `Install ${name} at ${entry?.sha.slice(0, 12)} for Main? Hermes validates the package and dependencies. It will stay disabled until you enable it.`
    : decision === 'remove' ? `Remove ${name} from Main? Review plugin-owned data before removal.`
      : `${decision === 'disable' ? 'Disable' : 'Enable'} ${name} for Main? Enabled plugins can execute with Hermes's access.`;
  const confirmLabel = decision === 'install' ? 'Install reviewed pin' : decision === 'remove' ? 'Remove plugin' : 'Confirm change';
  return createPortal(<dialog ref={dialog} aria-labelledby={titleId} aria-describedby={descriptionId}
    className="m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-2xl flex-col overflow-hidden rounded-3xl border border-edge bg-canvas p-0 text-ink shadow-2xl open:flex backdrop:bg-black/40 backdrop:backdrop-blur-sm"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <header className="flex shrink-0 items-start gap-4 border-b border-line bg-surface p-5 md:p-6">
      <PluginAppIcon name={name} large />
      <div className="min-w-0 flex-1 py-1"><h2 id={titleId} className="break-words text-xl font-semibold tracking-tight">{name}</h2>
        <p className="mt-1 text-xs text-muted">{entry?.maintainer || 'Publisher not provided'}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2"><StatusPill status={status} />{entry?.tier && <span className="text-[10px] capitalize text-muted">{entry.tier}</span>}{entry?.update_available && <span className="text-[10px] font-medium text-accent">Update available</span>}</div>
      </div>
      <button autoFocus type="button" onClick={onClose} aria-label="Close plugin details" className="-mr-1 -mt-1 shrink-0 rounded-full p-2 text-muted transition-colors hover:bg-neutral hover:text-ink cursor-pointer"><X size={18} /></button>
    </header>
    <div className="min-h-0 space-y-6 overflow-y-auto overscroll-contain p-5 md:p-6">
      <p id={descriptionId} className="whitespace-pre-wrap break-words text-sm leading-relaxed text-soft">{entry?.description || installed?.description || 'No description was provided for this plugin.'}</p>
      {feedback}
      {removedReason && <Notice error>{removedReason}</Notice>}
      {installed?.auth_required && <Notice>This plugin requires additional authentication. Follow its documentation to finish setup.</Notice>}
      {entry && <section className="space-y-4" aria-label="Plugin capabilities"><h3 className="text-sm font-semibold text-ink">What this app provides</h3>
        <CapabilityList title="Tools" values={entry.capabilities.provides_tools} />
        <CapabilityList title="Hooks" values={entry.capabilities.provides_hooks} />
        <CapabilityList title="Middleware" values={entry.capabilities.provides_middleware} />
        <div className="rounded-2xl border border-line bg-panel p-4"><h3 className="flex items-center gap-2 text-xs font-semibold text-ink"><KeyRound size={14} className="text-muted" />Required credentials</h3>
          <p className="mt-2 break-words font-mono text-xs text-soft">{entry.capabilities.requires_env.join(', ') || 'None declared'}</p>
          {!!entry.capabilities.requires_env.length && <p className="mt-2 text-xs leading-relaxed text-muted">Add these credentials under Models &amp; providers before enabling this app.</p>}
        </div>
      </section>}
      <section className="space-y-3" aria-label="Plugin information"><h3 className="text-sm font-semibold text-ink">App information</h3>
        <dl className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-4 gap-y-3 text-xs">
          <dt className="text-muted">Bot</dt><dd>Main</dd>
          {entry && <><dt className="text-muted">Publisher</dt><dd className="break-words">{entry.maintainer || 'Not provided'}</dd>
            <dt className="text-muted">Catalog tier</dt><dd className="capitalize">{entry.tier}</dd>
            <dt className="text-muted">Hermes version</dt><dd className="break-words">{entry.requires_hermes || 'No minimum declared'}</dd>
            <dt className="text-muted">Platforms</dt><dd className="break-words">{entry.platforms?.join(', ') || 'No restriction declared'}</dd>
            <dt className="text-muted">Catalog commit</dt><dd className="break-all font-mono text-[11px] select-text">{entry.sha}</dd>
            {entry.installed_sha && <><dt className="text-muted">Installed commit</dt><dd className="break-all font-mono text-[11px] select-text">{entry.installed_sha}</dd></>}
          </>}
          {installed && <><dt className="text-muted">Version</dt><dd className="break-words">{installed.version || 'Not reported'}</dd><dt className="text-muted">Source</dt><dd className="break-words">{installed.source || 'Not reported'}</dd><dt className="text-muted">Runtime status</dt><dd className="capitalize">{installed.runtime_status.replaceAll('_', ' ')}</dd></>}
        </dl>
        {!entry && <p className="text-xs text-muted">This installed plugin has no matching catalog entry. Publisher, compatibility and capabilities were not reported by the catalog.</p>}
        {(documentation || repository) && <div className="flex flex-wrap gap-3 pt-1">{documentation && <a className="inline-flex items-center gap-1 text-xs text-accent hover:underline" href={documentation} target="_blank" rel="noreferrer">Documentation<ArrowUpRight size={13} /></a>}{repository && <a className="inline-flex items-center gap-1 text-xs text-accent hover:underline" href={repository} target="_blank" rel="noreferrer">Source repository<ArrowUpRight size={13} /></a>}</div>}
      </section>
      <p className="rounded-xl border border-line p-3 text-[11px] leading-relaxed text-muted">Plugins can run code with Hermes's runtime access. Catalog tiers and reviewed commit pins do not replace reviewing an app's capabilities and requirements.</p>
      {decision && <section ref={confirmationPanel} className="space-y-3 rounded-2xl border border-edge bg-surface p-4" aria-label="Confirm plugin action">
        <p className="text-xs leading-relaxed text-soft">{confirmation}</p><div className="flex flex-wrap justify-end gap-2"><button type="button" className={buttonClass} disabled={busy} onClick={() => setDecision(null)}>Cancel</button><button type="button" className={decision === 'remove' ? dangerButtonClass : buttonClass} disabled={busy} onClick={() => { setDecision(null); onAction(decision); }}>{confirmLabel}</button></div>
      </section>}
    </div>
    <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line bg-surface px-5 py-4 md:px-6">
      <span className="text-[11px] text-muted">{busy ? 'Updating app...' : 'Managed by Hermes for Main'}</span>
      <div className="flex flex-wrap gap-2">
        {!isInstalled && entry && <button type="button" className={buttonClass} disabled={busy || !!removedReason} onClick={() => setDecision('install')}><Download size={14} />Install</button>}
        {installed && <>
          <button type="button" className={buttonClass} disabled={busy || !!removedReason} onClick={() => setDecision(installed.runtime_status === 'enabled' ? 'disable' : 'enable')}><Power size={14} />{installed.runtime_status === 'enabled' ? 'Disable' : 'Enable'}</button>
          {installed.can_update_git && entry?.installed && <button type="button" className={buttonClass} disabled={busy || !!removedReason} onClick={() => { setDecision(null); onAction('update'); }}><RefreshCw size={14} />Update to catalog pin</button>}
          {installed.can_remove && <button type="button" className={dangerButtonClass} disabled={busy} onClick={() => setDecision('remove')}><Trash2 size={14} />Remove</button>}
        </>}
      </div>
    </footer>
  </dialog>, document.body);
}

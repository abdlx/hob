import { useState } from 'react';
import { apiFetch } from '../services/api';
import { buttonClass, cardClass, ConfirmButton, Field, inputClass, Notice } from './WorkspaceUI';
import { errorText } from './workspaceUtils';
import { useToast } from '../context/ToastContext';

interface Credential { name: string; kind: string; allowedHosts?: string[]; updatedAtMs?: number }
export function CredentialsSettings() {
  const { toast } = useToast();
  const [entries, setEntries] = useState<Credential[]>([]);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [kind, setKind] = useState('secret');
  const [hosts, setHosts] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async () => setEntries((await apiFetch<{ entries: Credential[] }>('/api/credentials')).entries);
  const perform = async (work: () => Promise<unknown>) => { setBusy(true); setError(''); try { await work(); await load(); } catch (error) { setError(errorText(error)); } finally { setBusy(false); } };
  return <div className={`${cardClass} space-y-3`}>
    <div className="flex justify-between items-center">
      <h3 className="text-[13px] text-ink">Stored credentials &amp; environment</h3>
      <button disabled={busy} className={buttonClass} onClick={() => perform(load)}>Load credentials</button>
    </div>
    {error && <Notice error>{error}</Notice>}
    <Field label="Credential name" hint="Use the name expected by your connector or environment configuration."><input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} /></Field>
    <Field label="Value"><input className={inputClass} type="password" autoComplete="new-password" value={value} onChange={(event) => setValue(event.target.value)} /></Field>
    <Field label="Storage kind"><select className={inputClass} value={kind} onChange={(event) => setKind(event.target.value)}><option value="secret">Secret</option><option value="env">Environment variable</option></select></Field>
    {kind === 'secret' && <Field label="Allowed hosts (optional)" hint="Comma-separated domains where this secret may be used."><input className={inputClass} value={hosts} onChange={(event) => setHosts(event.target.value)} /></Field>}
    <button className={buttonClass} disabled={busy || !name.trim() || !value} onClick={() => perform(async () => {
      const result = await apiFetch<{ reloaded?: boolean; warningCount?: number }>('/api/credentials', { method: 'POST', body: JSON.stringify({ name: name.trim(), value, kind, ...(kind === 'secret' && hosts.trim() ? { allowedHosts: hosts.split(',').map((host) => host.trim()).filter(Boolean) } : {}) }) });
      setValue('');
      toast(result.reloaded ? 'Credential saved and the runtime refreshed.' : 'Credential saved. Reload the gateway credentials if it is currently disconnected.');
    })}>Save credential</button>
    {busy && <Notice>Updating OpenClaw credentials…</Notice>}
    {entries.map((entry) => <div key={entry.name} className="rounded-xl border border-hair p-3 space-y-2">
      <div className="flex justify-between gap-3">
        <div>
          <p className="text-[12px] text-ink">{entry.name}</p>
          <p className="text-[10px] text-muted">{entry.kind}{entry.allowedHosts?.length ? ` · ${entry.allowedHosts.join(', ')}` : ''}</p>
        </div>
        <div className="flex gap-2">
          <button className={buttonClass} disabled={busy} onClick={() => { setName(entry.name); setValue(''); setKind(entry.kind); setHosts(entry.allowedHosts?.join(', ') || ''); }}>Replace</button>
          <ConfirmButton className={buttonClass} disabled={busy} tone="danger" confirmLabel="Remove" message="Remove this stored credential? Connectors using it will stop working." onConfirm={() => { void perform(async () => { await apiFetch(`/api/credentials/${encodeURIComponent(entry.name)}`, { method: 'DELETE' }); toast('Credential removed.'); }); }}>Remove</ConfirmButton>
        </div>
      </div>
    </div>)}
  </div>;
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hermesSetupApi, setupLink } from '../services/hermes-setup';
import { memoryProviderEdits } from '../services/hermes-memory';
import type { MemoryDraft, MemoryField, MemoryProvider, MemorySchema, MemoryStatus } from '../services/hermes-memory';
import { buttonClass, cardClass, Field, inputClass, Notice } from './WorkspaceUI';
import { errorText } from './workspaceUtils';

const write = (method: string, value: unknown) => ({ method, body: JSON.stringify(value) });
function ProviderField({ field, value, edit }: { field: MemoryField; value: string | boolean | number; edit: (value: string) => void }) {
  return <Field label={field.label || field.key} hint={`${field.description || ''}${field.kind === 'secret' ? ` ${field.isSet ? 'Credential stored.' : 'No credential stored.'} Leave blank to keep the existing value.` : ''}`}>
    {field.kind === 'boolean' ? <select className={inputClass} value={String(value)} onChange={event => edit(event.target.value)}><option value="true">Enabled</option><option value="false">Disabled</option></select>
      : field.kind === 'select' ? <select className={inputClass} value={String(value)} onChange={event => edit(event.target.value)}>{field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        : field.kind === 'json' ? <textarea className={`${inputClass} font-mono`} rows={4} value={String(value)} onChange={event => edit(event.target.value)} />
          : <input className={inputClass} type={field.kind === 'secret' ? 'password' : ['integer', 'number'].includes(field.kind) ? 'number' : 'text'} autoComplete={field.kind === 'secret' ? 'new-password' : 'off'}
            value={String(value)} placeholder={field.placeholder} min={field.minimum} max={field.maximum} step={field.step ?? (field.kind === 'integer' ? 1 : field.kind === 'number' ? 'any' : undefined)} onChange={event => edit(event.target.value)} />}
  </Field>;
}

function ProviderForm({ profile, provider, update }: { profile: string; provider: MemoryProvider; update: (data: MemoryStatus) => void }) {
  const api = useMemo(() => hermesSetupApi(profile), [profile]);
  const route = `memory/providers/${encodeURIComponent(provider.name)}`;
  const [schema, setSchema] = useState<MemorySchema | null>(null), [draft, setDraft] = useState<MemoryDraft>({});
  const [error, setError] = useState(''), [status, setStatus] = useState(''), [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState<'save' | 'setup' | 'select' | null>(null);
  const mounted = useRef(false), pending = useRef(false), revision = useRef(0);
  const load = useCallback(async () => {
    const current = ++revision.current;
    const result = await api<MemorySchema>(route);
    if (mounted.current && current === revision.current) { setSchema(result); setDraft({}); }
  }, [api, route]);
  useEffect(() => {
    const generation = revision;
    mounted.current = true;
    void load().catch(error => { if (mounted.current) setError(errorText(error)); });
    return () => { mounted.current = false; generation.current++; };
  }, [load]);
  const confirm = async () => {
    if (!decision || pending.current) return;
    const selected = decision; setDecision(null); pending.current = true; setBusy(true); setError(''); setStatus('');
    try {
      let result: MemoryStatus;
      if (selected === 'setup') {
        const setup = await api<{ ok: boolean; memory: MemoryStatus }>(`${route}/setup`, write('POST', { confirm: true }));
        result = setup.memory;
        if (mounted.current) setStatus(setup.ok ? 'Hermes completed dependency setup. Check readiness below; the provider was not selected by this action.' : 'Native setup did not finish. Refresh the provider status before trying again.');
      } else if (selected === 'select') result = await api<MemoryStatus>('memory/provider', write('PUT', { provider: provider.name, confirm: true }));
      else {
        if (!schema) throw new Error('Wait for the provider form to load.');
        result = await api<MemoryStatus>(route, write('PUT', { surface: schema.surface, values: memoryProviderEdits(schema.fields, draft), confirm: true }));
      }
      if (mounted.current) {
        update(result);
        if (selected !== 'setup') setStatus('Settings submitted to Hermes. Check the active provider and readiness below; selection alone does not prove a successful recall.');
      }
      await load();
    } catch (error) {
      if (mounted.current) setError(errorText(error) + ' The native operation may have saved partial settings. Refresh and inspect the provider before retrying.');
      try { const result = await api<MemoryStatus>('memory'); if (mounted.current) update(result); } catch { /* Keep the original error. */ }
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const edits = schema ? memoryProviderEdits(schema.fields, draft) : {};
  return <div className="space-y-3 border border-[#302a23] rounded-xl p-3">
    <h3 className="text-sm text-[#dfd1bd]">{schema?.label || provider.name}</h3><p className="text-xs text-[#958b7d]">{provider.description} · {provider.status}</p>
    {error && <Notice error>{error}</Notice>}{status && <Notice>{status}</Notice>}
    {!schema && !error && <Notice>Loading provider fields…</Notice>}
    <fieldset disabled={busy || !schema} className="space-y-3">{schema?.fields.map(field => <div key={field.key}>
      <ProviderField field={field} value={Object.hasOwn(draft, field.key) ? draft[field.key] : field.value} edit={value => { revision.current++; setDecision(null); setDraft(previous => ({ ...previous, [field.key]: value })); }} />
      {field.when && <p className="text-xs text-[#958b7d]">Hermes applies this field when {Object.entries(field.when).map(([key, value]) => `${key} = ${String(value)}`).join(', ')}.</p>}
    </div>)}</fieldset>
    {schema && !schema.fields.length && <Notice>No provider-specific form is available. Native configuration may be needed before selection.</Notice>}
    {setupLink(schema?.docs_url) && <a className={buttonClass} href={setupLink(schema?.docs_url)} target="_blank" rel="noreferrer noopener">Provider instructions</a>}
    {(provider.setup.pythonPackages.length > 0 || provider.setup.externalDependencies.length > 0) && <Notice>Native dependencies: {[...provider.setup.pythonPackages, ...provider.setup.externalDependencies.map(item => item.name)].join(', ')}. Setup can take several minutes.</Notice>}
    <div className="flex flex-wrap gap-2">
      <button className={buttonClass} disabled={busy || !schema || !Object.keys(edits).length} onClick={() => setDecision('save')}>Review save and select</button>
      <button className={buttonClass} disabled={busy} onClick={() => setDecision('select')}>Select existing configuration</button>
      <button className={buttonClass} disabled={busy} onClick={() => setDecision('setup')}>Set up dependencies</button>
      <button className={buttonClass} disabled={busy} onClick={() => { setError(''); void load().catch(error => { if (mounted.current) setError(errorText(error)); }); }}>Refresh provider form</button>
    </div>
    {decision && <Notice>{decision === 'setup' ? `Allow Hermes to install packages or run ${provider.name}’s declared setup on its host? This may contact external services. Unsaved field edits are not submitted.`
      : `Select ${provider.name} for this bot${decision === 'save' ? ' and save the edited fields' : ''}? The provider may receive this bot’s conversations and memory. Choosing the same external project or namespace for multiple bots may share their data. Existing memory is not automatically migrated or deleted.`}
      {' '}<button className={buttonClass} disabled={busy} onClick={confirm}>Confirm memory {decision === 'setup' ? 'setup' : 'selection'}</button>
      {' '}<button className={buttonClass} disabled={busy} onClick={() => setDecision(null)}>Cancel memory confirmation</button>
    </Notice>}
    {busy && <Notice>Waiting for Hermes. This does not mean setup or activation has completed.</Notice>}
  </div>;
}

export function HermesMemorySettings({ profile }: { profile: string }) {
  const api = useMemo(() => hermesSetupApi(profile), [profile]);
  const [data, setData] = useState<MemoryStatus | null>(null), [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState(''), [confirmBuiltin, setConfirmBuiltin] = useState(false), [busy, setBusy] = useState(false);
  const mounted = useRef(false), revision = useRef(0), pending = useRef(false);
  const load = useCallback(async () => {
    const current = ++revision.current;
    const result = await api<MemoryStatus>('memory');
    if (mounted.current && current === revision.current) { setData(result); setSelected(previous => previous ?? result.active); }
  }, [api]);
  useEffect(() => { const generation = revision; mounted.current = true; void load().catch(error => { if (mounted.current) setError(errorText(error)); }); return () => { mounted.current = false; generation.current++; }; }, [load]);
  const provider = data?.providers.find(item => item.name === selected);
  return <section className={`${cardClass} space-y-3`}><div className="flex justify-between gap-2"><h2 className="text-sm text-[#dfd1bd]">Memory providers</h2><button className={buttonClass} disabled={busy} onClick={() => { setError(''); void load().catch(error => { if (mounted.current) setError(errorText(error)); }); }}>Refresh memory status</button></div>
    <Notice>Built-in MEMORY.md and USER.md stay with the bot. An external provider adds its own recall and storage; it may send conversations to another service. Changing providers does not migrate or erase existing memory.</Notice>
    {error && <Notice error>{error}</Notice>}{!data && !error && <Notice>Loading memory providers…</Notice>}
    {data && <p className="text-xs text-[#958b7d]">Selected provider: {data.active || 'Built-in only'}. Built-in files: MEMORY.md {data.builtinFiles.memory ?? 0} bytes · USER.md {data.builtinFiles.user ?? 0} bytes.</p>}
    <Field label="Memory provider"><select className={inputClass} disabled={!data || busy} value={selected ?? ''} onChange={event => { revision.current++; setSelected(event.target.value); setConfirmBuiltin(false); }}><option value="">Built-in only</option>{data?.providers.map(item => <option key={item.name} value={item.name}>{item.name} · {item.status}</option>)}</select></Field>
    {selected === '' && data?.active && <button className={buttonClass} disabled={busy} onClick={() => setConfirmBuiltin(true)}>Use built-in memory only</button>}
    {confirmBuiltin && <Notice>Stop selecting the external provider for future native sessions? Existing data and credentials remain stored; active sessions may need restarting.
      {' '}<button className={buttonClass} disabled={busy} onClick={async () => {
        if (pending.current) return;
        pending.current = true; setBusy(true); setError(''); revision.current++;
        try { const result = await api<MemoryStatus>('memory/provider', write('PUT', { provider: '', confirm: true })); if (mounted.current) { setData(result); setConfirmBuiltin(false); } }
        catch (error) { if (mounted.current) setError(errorText(error)); }
        finally { pending.current = false; if (mounted.current) setBusy(false); }
      }}>Confirm built-in memory</button>{' '}<button className={buttonClass} disabled={busy} onClick={() => setConfirmBuiltin(false)}>Cancel</button></Notice>}
    {provider && <ProviderForm key={`${profile}:${provider.name}`} profile={profile} provider={provider} update={result => { revision.current++; setData(result); }} />}
    {selected && !provider && data && <Notice error>The selected provider is unavailable in this native catalog. Refresh or select built-in memory.</Notice>}
  </section>;
}

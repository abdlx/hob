import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hermesSetupApi, setupLink } from '../services/hermes-setup';
import { memoryProviderEdits } from '../services/hermes-memory';
import type { MemoryDraft, MemoryField, MemoryProvider, MemorySchema, MemoryStatus } from '../services/hermes-memory';
import { useToast } from '../context/ToastContext';
import { buttonClass, cardClass, ConfirmButton, Field, inputClass, Notice, Skeleton } from './WorkspaceUI';
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
  const { toast } = useToast();
  const api = useMemo(() => hermesSetupApi(profile), [profile]);
  const route = `memory/providers/${encodeURIComponent(provider.name)}`;
  const [schema, setSchema] = useState<MemorySchema | null>(null), [draft, setDraft] = useState<MemoryDraft>({});
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
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
  const confirm = async (selected: 'save' | 'setup' | 'select') => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      let result: MemoryStatus;
      if (selected === 'setup') {
        const setup = await api<{ ok: boolean; memory: MemoryStatus }>(`${route}/setup`, write('POST', { confirm: true }));
        result = setup.memory;
        toast(setup.ok ? 'Hermes completed dependency setup. Check readiness below; the provider was not selected by this action.' : 'Native setup did not finish. Refresh the provider status before trying again.');
      } else if (selected === 'select') result = await api<MemoryStatus>('memory/provider', write('PUT', { provider: provider.name, confirm: true }));
      else {
        if (!schema) throw new Error('Wait for the provider form to load.');
        result = await api<MemoryStatus>(route, write('PUT', { surface: schema.surface, values: memoryProviderEdits(schema.fields, draft), confirm: true }));
      }
      if (mounted.current) {
        update(result);
        if (selected !== 'setup') toast('Settings submitted to Hermes. Check the active provider and readiness below; selection alone does not prove a successful recall.');
      }
      await load();
    } catch (error) {
      if (mounted.current) setError(errorText(error) + ' The native operation may have saved partial settings. Refresh and inspect the provider before retrying.');
      try { const result = await api<MemoryStatus>('memory'); if (mounted.current) update(result); } catch { /* Keep the original error. */ }
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const edits = schema ? memoryProviderEdits(schema.fields, draft) : {};
  return <div className="space-y-3 border border-hair rounded-xl p-3">
    <h3 className="text-sm text-ink">{schema?.label || provider.name}</h3><p className="text-xs text-muted">{provider.description} · {provider.status}</p>
    {error && <Notice error>{error}</Notice>}
    {!schema && !error && <div className="space-y-3"><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-2/3" /></div>}
    <fieldset disabled={busy || !schema} className="space-y-3">{schema?.fields.map(field => <div key={field.key}>
      <ProviderField field={field} value={Object.hasOwn(draft, field.key) ? draft[field.key] : field.value} edit={value => { revision.current++; setDraft(previous => ({ ...previous, [field.key]: value })); }} />
      {field.when && <p className="text-xs text-muted">Hermes applies this field when {Object.entries(field.when).map(([key, value]) => `${key} = ${String(value)}`).join(', ')}.</p>}
    </div>)}</fieldset>
    {schema && !schema.fields.length && <Notice>No provider-specific form is available. Native configuration may be needed before selection.</Notice>}
    {setupLink(schema?.docs_url) && <a className={buttonClass} href={setupLink(schema?.docs_url)} target="_blank" rel="noreferrer noopener">Provider instructions</a>}
    {(provider.setup.pythonPackages.length > 0 || provider.setup.externalDependencies.length > 0) && <Notice>Native dependencies: {[...provider.setup.pythonPackages, ...provider.setup.externalDependencies.map(item => item.name)].join(', ')}. Setup can take several minutes.</Notice>}
    <div className="flex flex-wrap gap-2">
      <ConfirmButton disabled={busy || !schema || !Object.keys(edits).length} message={<>Select {provider.name} for this bot and save the edited fields? The provider may receive this bot’s conversations and memory. Choosing the same external project or namespace for multiple bots may share their data. Existing memory is not automatically migrated or deleted.</>} confirmLabel="Confirm memory selection" onConfirm={() => { void confirm('save'); }}>Review save and select</ConfirmButton>
      <ConfirmButton disabled={busy} message={<>Select {provider.name} for this bot? The provider may receive this bot’s conversations and memory. Choosing the same external project or namespace for multiple bots may share their data. Existing memory is not automatically migrated or deleted.</>} confirmLabel="Confirm memory selection" onConfirm={() => { void confirm('select'); }}>Select existing configuration</ConfirmButton>
      <ConfirmButton disabled={busy} message={<>Allow Hermes to install packages or run {provider.name}’s declared setup on its host? This may contact external services. Unsaved field edits are not submitted.</>} confirmLabel="Confirm memory setup" onConfirm={() => { void confirm('setup'); }}>Set up dependencies</ConfirmButton>
      <button className={buttonClass} disabled={busy} onClick={() => { setError(''); void load().catch(error => { if (mounted.current) setError(errorText(error)); }); }}>Refresh provider form</button>
    </div>
    {busy && <Notice>Waiting for Hermes. This does not mean setup or activation has completed.</Notice>}
  </div>;
}

export function HermesMemorySettings({ profile }: { profile: string }) {
  const api = useMemo(() => hermesSetupApi(profile), [profile]);
  const [data, setData] = useState<MemoryStatus | null>(null), [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const mounted = useRef(false), revision = useRef(0), pending = useRef(false);
  const load = useCallback(async () => {
    const current = ++revision.current;
    const result = await api<MemoryStatus>('memory');
    if (mounted.current && current === revision.current) { setData(result); setSelected(previous => previous ?? result.active); }
  }, [api]);
  useEffect(() => { const generation = revision; mounted.current = true; void load().catch(error => { if (mounted.current) setError(errorText(error)); }); return () => { mounted.current = false; generation.current++; }; }, [load]);
  const provider = data?.providers.find(item => item.name === selected);
  const selectBuiltin = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); revision.current++;
    try { const result = await api<MemoryStatus>('memory/provider', write('PUT', { provider: '', confirm: true })); if (mounted.current) setData(result); }
    catch (error) { if (mounted.current) setError(errorText(error)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return <section className={`${cardClass} space-y-3`}><div className="flex justify-between gap-2"><h2 className="text-sm text-ink">Memory providers</h2><button className={buttonClass} disabled={busy} onClick={() => { setError(''); void load().catch(error => { if (mounted.current) setError(errorText(error)); }); }}>Refresh memory status</button></div>
    <Notice>Built-in MEMORY.md and USER.md stay with the bot. An external provider adds its own recall and storage; it may send conversations to another service. Changing providers does not migrate or erase existing memory.</Notice>
    {error && <Notice error>{error}</Notice>}{!data && !error && <div className="space-y-3"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-9 w-full" /></div>}
    {data && <p className="text-xs text-muted">Selected provider: {data.active || 'Built-in only'}. Built-in files: MEMORY.md {data.builtinFiles.memory ?? 0} bytes · USER.md {data.builtinFiles.user ?? 0} bytes.</p>}
    <Field label="Memory provider"><select className={inputClass} disabled={!data || busy} value={selected ?? ''} onChange={event => { revision.current++; setSelected(event.target.value); }}><option value="">Built-in only</option>{data?.providers.map(item => <option key={item.name} value={item.name}>{item.name} · {item.status}</option>)}</select></Field>
    {selected === '' && data?.active && <ConfirmButton tone="danger" disabled={busy} message={<>Stop selecting the external provider for future native sessions? Existing data and credentials remain stored; active sessions may need restarting.</>} confirmLabel="Confirm built-in memory" onConfirm={() => { void selectBuiltin(); }}>Use built-in memory only</ConfirmButton>}
    {provider && <ProviderForm key={`${profile}:${provider.name}`} profile={profile} provider={provider} update={result => { revision.current++; setData(result); }} />}
    {selected && !provider && data && <Notice error>The selected provider is unavailable in this native catalog. Refresh or select built-in memory.</Notice>}
  </section>;
}

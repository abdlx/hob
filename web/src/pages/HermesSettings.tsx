import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, chatApi } from '../services/api';
import { hermesConfigChanges, hermesModelSelectionResult } from '../services/hermes-settings';
import type { HermesConfig } from '../services/hermes-settings';
import { buttonClass, cardClass, Field, inputClass, Notice } from '../components/WorkspaceUI';
import { errorText } from '../components/workspaceUtils';
import { HermesModelPicker } from '../components/HermesModelPicker';
import { HermesAccountsSettings, HermesChannelsSettings, HermesToolsSettings } from '../components/HermesIntegrations';
import { HermesMcpSettings } from '../components/HermesMcpSettings';
import { HermesMemorySettings } from '../components/HermesMemorySettings';
import { HermesLearningSettings } from '../components/HermesLearningSettings';

interface Profile { name: string; display_name?: string; description?: string; model?: string; provider?: string; state?: string }
interface Credential { is_set: boolean; description?: string; category?: string }

export function HermesSettings() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profile, setProfile] = useState(() => chatApi.getProfile());
  const [snapshot, setSnapshot] = useState<HermesConfig | null>(null);
  const [configText, setConfigText] = useState('');
  const [credentials, setCredentials] = useState<Record<string, Credential>>({});
  const [key, setKey] = useState('OPENAI_API_KEY');
  const [secret, setSecret] = useState('');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [endpointName, setEndpointName] = useState('');
  const [endpointSecret, setEndpointSecret] = useState('');
  const [modelConfirmation, setModelConfirmation] = useState('');
  const [newName, setNewName] = useState('');
  const [soul, setSoul] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const loadSequence = useRef(0);
  const invalidateLoads = useCallback(() => { loadSequence.current++; }, []);
  const scoped = useCallback((path: string) => `/api/hermes/${path}?profile=${encodeURIComponent(profile)}`, [profile]);
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const roster = await apiFetch<{ profiles: Profile[] }>('/api/hermes/profiles');
      if (sequence !== loadSequence.current) return;
      setProfiles(roster.profiles);
      const [config, keys] = await Promise.all([
        apiFetch<HermesConfig>(scoped('config')),
        apiFetch<Record<string, Credential>>(scoped('credentials')),
      ]);
      if (sequence !== loadSequence.current) return;
      setSnapshot(config);
      setConfigText(JSON.stringify(config, null, 2));
      setCredentials(keys);
      setError('');
    } catch (error) { if (sequence === loadSequence.current) setError(errorText(error)); }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  }, [scoped]);
  useEffect(() => { const timer = window.setTimeout(load, 0); return () => { window.clearTimeout(timer); invalidateLoads(); }; }, [load, invalidateLoads]);
  async function action(work: () => Promise<unknown>, message: string) {
    setBusy(true); setError(''); setStatus('');
    try { await work(); await load(); setStatus(message); }
    catch (error) { await load(); setError(errorText(error)); }
    finally { setBusy(false); }
  }
  const submit = (path: string, value: unknown, method = 'PUT') => apiFetch(scoped(path), { method, body: JSON.stringify(value) });
  async function selectModel(confirmExpensive = false) {
    setBusy(true); setError(''); setStatus('');
    try {
      let selectedProvider = provider.trim();
      if (baseUrl.trim() && ['custom', 'local'].includes(selectedProvider.toLowerCase())) {
        // A named native endpoint binds URL + key to an identity. Bare custom
        // can resolve an older saved endpoint serving the same model name.
        const endpoint = await submit('custom-endpoints', { name: endpointName.trim(), base_url: baseUrl.trim(), model: model.trim(),
          ...(endpointSecret ? { api_key: endpointSecret } : {}), make_default: false }, 'POST') as { ok?: boolean; id?: string };
        if (endpoint.ok !== true || !endpoint.id) throw new Error('Hermes did not confirm the custom endpoint. Refresh settings before retrying.');
        selectedProvider = endpoint.id;
        setEndpointSecret('');
      }
      const result = hermesModelSelectionResult(await submit('model', { scope: 'main', provider: selectedProvider, model: model.trim(),
        ...(baseUrl.trim() ? { base_url: baseUrl.trim() } : {}), ...(confirmExpensive ? { confirm_expensive_model: true } : {}) }, 'POST'));
      if (!result.saved) { setModelConfirmation(result.confirmation); return; }
      setModelConfirmation('');
      await load();
      setStatus('Model selection saved. Start a new conversation to use the updated setup.');
    } catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  }

  return <div className="space-y-5">
    <div className="flex items-center justify-between gap-3"><p className="text-xs md:text-sm text-[#baa995]">Configure Hermes and your independent bots.</p><button className={buttonClass} disabled={busy || loading} onClick={load}>Refresh</button></div>
    {error && <Notice error>{error}</Notice>}{status && <Notice>{status}</Notice>}
    <Field label="Bot"><select className={inputClass} disabled={busy || loading} value={profile} onChange={event => { loadSequence.current++; setProfile(event.target.value); setSnapshot(null); setSecret(''); setProvider(''); setModel(''); setBaseUrl(''); setEndpointName(''); setEndpointSecret(''); setModelConfirmation(''); setStatus(''); }}>
      <option value="default">Main</option>{profiles.filter(item => item.name !== 'default' && (!item.state || item.state === 'active')).map(item => <option key={item.name} value={item.name}>{item.display_name || item.name}</option>)}
    </select></Field>
    <section className={`${cardClass} space-y-3.5`}><h2 className="text-base md:text-lg font-semibold text-[#f0e4d4]">Connect a model</h2>
      <HermesModelPicker key={profile} profile={profile} provider={provider} model={model} busy={busy}
        chooseProvider={(value, keyEnv) => { setProvider(value); setModel(''); setBaseUrl(''); setEndpointName(''); setEndpointSecret(''); setModelConfirmation(''); setSecret(''); setKey(keyEnv || ''); }}
        chooseModel={value => { setModel(value); setModelConfirmation(''); }} />
      <Field label="Credential name" hint="Provider and tool credentials are stored by Hermes for the selected bot."><input className={inputClass} list="hermes-credential-names" value={key} disabled={busy} onChange={event => setKey(event.target.value)} /><datalist id="hermes-credential-names">{Object.keys(credentials).map(name => <option key={name} value={name} />)}</datalist></Field>
      <Field label="API key" hint={credentials[key]?.is_set ? 'A credential is already stored. Leave it unchanged unless you intend to replace it.' : 'Enter the key supplied by your provider.'}><input className={inputClass} type="password" autoComplete="new-password" value={secret} disabled={busy} onChange={event => setSecret(event.target.value)} /></Field>
      <button className={buttonClass} disabled={busy || !key.trim() || !secret.trim()} onClick={() => action(async () => { await submit('credentials', { key: key.trim(), value: secret }); setSecret(''); }, 'Credential saved for this bot.')}>Save credential</button>
      <Field label="Custom endpoint (optional)" hint="For a local or compatible provider, enter its API base URL. Leave blank to use the provider’s normal endpoint."><input className={inputClass} value={baseUrl} placeholder="http://localhost:8000/v1" disabled={busy} onChange={event => { setBaseUrl(event.target.value); setModelConfirmation(''); }} /></Field>
      {baseUrl.trim() && ['custom', 'local'].includes(provider.trim().toLowerCase()) && <div className="space-y-3">
        <Field label="Endpoint name" hint="Give this endpoint a distinct name. Reusing a name updates that saved endpoint."><input className={inputClass} value={endpointName} disabled={busy} onChange={event => { setEndpointName(event.target.value); setModelConfirmation(''); }} /></Field>
        <Field label="Custom endpoint API key (optional)" hint="This key belongs to this endpoint. Leave blank for a keyless local server or to preserve its existing credential."><input className={inputClass} type="password" autoComplete="new-password" value={endpointSecret} disabled={busy} onChange={event => { setEndpointSecret(event.target.value); setModelConfirmation(''); }} /></Field>
      </div>}
      <button className={buttonClass} disabled={busy || !provider.trim() || !model.trim() || Boolean(baseUrl.trim() && ['custom', 'local'].includes(provider.trim().toLowerCase()) && !endpointName.trim())} onClick={() => selectModel()}>Select model</button>
      {modelConfirmation && <div className="space-y-2"><Notice>{modelConfirmation}</Notice><button className={buttonClass} disabled={busy} onClick={() => selectModel(true)}>Confirm this model selection</button></div>}
    </section>
    <HermesAccountsSettings key={`accounts:${profile}`} profile={profile} />
    <HermesToolsSettings key={`tools:${profile}`} profile={profile} />
    <HermesMcpSettings key={`mcp:${profile}`} profile={profile} />
    <HermesMemorySettings key={`memory:${profile}`} profile={profile} />
    <HermesLearningSettings key={`learning:${profile}`} profile={profile} />
    <HermesChannelsSettings key={`channels:${profile}`} profile={profile} />
    <section className={`${cardClass} space-y-3`}><h2 className="text-sm text-[#dfd1bd]">Create a bot</h2>
      <Field label="Name" hint="Use lowercase letters, digits, underscores or hyphens; start with a letter."><input className={inputClass} value={newName} disabled={busy} onChange={event => setNewName(event.target.value)} /></Field>
      <Field label="Personality and instructions"><textarea className={inputClass} rows={4} value={soul} disabled={busy} onChange={event => setSoul(event.target.value)} /></Field>
      <Notice>New bots have their own state. Creating one does not copy another bot’s private memories or channel credentials.</Notice>
      <button className={buttonClass} disabled={busy || !/^[a-z][a-z0-9_-]{0,63}$/.test(newName) || newName === 'default'} onClick={() => action(async () => { await apiFetch('/api/hermes/profiles', { method: 'POST', body: JSON.stringify({ name: newName, soul }) }); setNewName(''); setSoul(''); }, 'Bot created. Select it above to connect its model and credentials.')}>Create bot</button>
      {profiles.filter(item => item.state === 'setup_required').map(item => <div key={item.name} className="space-y-2">
        <Notice>Setup for {item.name} did not finish. Confirm that its existing Hermes profile should be used as your bot; this assigns its working directory and private listener credential. No model key or memory is copied from another bot.</Notice>
        <button className={buttonClass} disabled={busy} onClick={() => action(() => apiFetch(`/api/hermes/profiles/${encodeURIComponent(item.name)}/finish-setup`, { method: 'POST', body: JSON.stringify({ confirmExisting: true }) }), `Setup finished for ${item.name}.`)}>Confirm profile and finish setup: {item.name}</button>
      </div>)}
    </section>
    <section className={`${cardClass} space-y-3`}><h2 className="text-sm text-[#dfd1bd]">Hermes configuration</h2>
      <Notice>These are the selected bot’s native Hermes settings. Only edits are submitted. Stored credential placeholders are preserved; use the credential form to replace a key. A removed JSON field is not a reset.</Notice>
      {loading ? <Notice>Loading Hermes settings…</Notice> : <textarea aria-label="Hermes configuration JSON" className={`${inputClass} font-mono`} rows={20} value={configText} disabled={busy || !snapshot} onChange={event => setConfigText(event.target.value)} />}
      <button className={buttonClass} disabled={busy || loading || !snapshot} onClick={() => action(async () => {
        const config: unknown = JSON.parse(configText);
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Configuration must be a JSON object.');
        const changes = hermesConfigChanges(snapshot!, config as HermesConfig);
        if (Object.keys(changes).length) await submit('config', { config: changes });
      }, 'Settings saved. Some Hermes settings take effect on a new session or after a runtime restart.')}>Save settings</button>
    </section>
  </div>;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, chatApi } from '../services/api';
import { hermesConfigChanges, hermesModelSelectionResult, providerCredentialName } from '../services/hermes-settings';
import type { HermesConfig, HermesCredential } from '../services/hermes-settings';
import { buttonClass, cardClass, Field, inputClass, Notice, Skeleton } from '../components/WorkspaceUI';
import { errorText } from '../components/workspaceUtils';
import { useToast } from '../context/ToastContext';
import { HermesModelPicker } from '../components/HermesModelPicker';
import { HermesSavedProviders } from '../components/HermesSavedProviders';
import { HermesAccountsSettings, HermesChannelsSettings, HermesToolsSettings } from '../components/HermesIntegrations';
import { HermesMcpSettings } from '../components/HermesMcpSettings';
import { HermesMemorySettings } from '../components/HermesMemorySettings';
import { HermesLearningSettings } from '../components/HermesLearningSettings';
import { HermesConfigEditor } from '../components/HermesConfigEditor';
import type { HermesConfigSchema } from '../components/HermesConfigEditor';
import { Search, SlidersHorizontal } from 'lucide-react';
import { preference, savePreference, searchSettings, settingsSection, settingsSections } from '../services/settings-navigation';
import type { SettingsSection } from '../services/settings-navigation';
import { AppearanceSettings } from '../components/AppearanceSettings';
import { HermesPluginsSettings } from '../components/HermesPluginsSettings';
import { HermesAutonomySettings } from '../components/HermesAutonomySettings';
import { HermesGoals, HermesWorkshop } from './HermesWorkspace';
import { BotPreferences } from '../components/BotPreferences';

interface Profile { name: string; display_name?: string; description?: string; model?: string; provider?: string; state?: string }

export function HermesSettings() {
  const [profile, setProfile] = useState(() => chatApi.getProfile());
  const [section, setSection] = useState(() => settingsSection(preference('hob:settings-section', 'models')));
  const [visited, setVisited] = useState<Set<SettingsSection>>(() => new Set([section]));
  const [search, setSearch] = useState('');
  const matches = searchSettings(search);
  const current = settingsSections.find(item => item.id === section)!;
  return <div className="settings-workspace grid gap-5 lg:grid-cols-[200px_minmax(0,1fr)]">
    <aside className="min-w-0 lg:sticky lg:top-0 lg:self-start">
      <div className="relative mb-3"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><input aria-label="Find settings category" className={`${inputClass} pl-9`} placeholder="Find settings…" value={search} onChange={event => setSearch(event.target.value)} /></div>
      <nav aria-label="Settings categories" className="flex gap-1 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible">
        {matches.map(item => <button key={item.id} aria-current={section === item.id ? 'page' : undefined} className={`shrink-0 rounded-lg px-3 py-2 text-left text-xs transition-colors ${section === item.id ? 'bg-accent-soft text-accent font-semibold' : 'text-soft hover:bg-hover hover:text-ink'}`} onClick={() => { setVisited(previous => new Set([...previous, item.id])); setSection(item.id); savePreference('hob:settings-section', item.id); }}><span className="block whitespace-nowrap">{item.title}</span><span className="mt-1 hidden text-[10px] font-normal leading-relaxed opacity-80 lg:block">{item.description}</span></button>)}
      </nav>
      {matches.length === 0 && <p className="py-2 text-xs text-muted">No matching category. Search all native fields in Advanced configuration.</p>}
    </aside>
    <div className="min-w-0"><div className="mb-5 flex items-start gap-3"><SlidersHorizontal size={18} className="mt-0.5 text-muted" /><div><h2 className="text-base font-semibold text-ink">{current.title}</h2><p className="mt-1 text-xs text-muted">{current.description}</p></div></div>
      <ProfileSettings key={profile} profile={profile} setProfile={value => { setVisited(new Set([section])); setProfile(value); }} section={section} visited={visited} />
    </div>
  </div>;
}

function ProfileSettings({ profile, setProfile, section, visited }: { profile: string; setProfile: (value: string) => void; section: SettingsSection; visited: Set<SettingsSection> }) {
  const { toast } = useToast();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const mounted = useRef(true);
  const modelForm = useRef<HTMLElement>(null);
  const pending = useRef(false);
  const [snapshot, setSnapshot] = useState<HermesConfig | null>(null);
  const [schema, setSchema] = useState<HermesConfigSchema | null>(null);
  const [configRevision, setConfigRevision] = useState(0);
  const [configText, setConfigText] = useState('');
  const [credentials, setCredentials] = useState<Record<string, HermesCredential>>({});
  const [key, setKey] = useState('OPENAI_API_KEY');
  const [secret, setSecret] = useState('');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [endpointName, setEndpointName] = useState('');
  const [endpointSecret, setEndpointSecret] = useState('');
  const [modelConfirmation, setModelConfirmation] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('');
  const [soul, setSoul] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const loadSequence = useRef(0);
  const invalidateLoads = useCallback(() => { loadSequence.current++; }, []);
  const scoped = useCallback((path: string) => `/api/hermes/${path}?profile=${encodeURIComponent(profile)}`, [profile]);
  const request = useCallback(<T,>(path: string, init: RequestInit = {}) => apiFetch<T>(path, { ...init, headers: { 'X-Hob-Profile': profile } }), [profile]);
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const roster = await request<{ profiles: Profile[] }>('/api/hermes/profiles');
      if (sequence !== loadSequence.current) return;
      setProfiles(roster.profiles);
      const [config, keys, configSchema] = await Promise.all([
        request<HermesConfig>(scoped('config')),
        request<Record<string, HermesCredential>>(scoped('credentials')),
        request<HermesConfigSchema>(scoped('config/schema')),
      ]);
      if (sequence !== loadSequence.current) return;
      setSnapshot(config);
      setSchema(configSchema);
      setConfigRevision(value => value + 1);
      setConfigText(JSON.stringify(config, null, 2));
      setCredentials(keys);
      setError('');
    } catch (error) { if (sequence === loadSequence.current) setError(errorText(error)); }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  }, [scoped, request]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { const timer = window.setTimeout(load, 0); return () => { window.clearTimeout(timer); invalidateLoads(); }; }, [load, invalidateLoads]);
  async function action(work: () => Promise<unknown>, message: string) {
    if (pending.current) throw new Error('Another settings operation is running.');
    pending.current = true; setBusy(true); setError('');
    try { await work(); if (mounted.current) { toast(message); await load(); } }
    catch (error) { if (mounted.current) setError(errorText(error)); throw error; }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  const runAction = (work: () => Promise<unknown>, message: string) => { void action(work, message).catch(() => undefined); };
  const submit = (path: string, value: unknown, method = 'PUT') => request(scoped(path), { method, body: JSON.stringify(value) });
  async function selectModel(confirmExpensive = false) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setError('');
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
      if (result.saved === false && result.confirmation) { setModelConfirmation(result.confirmation); return; }
      setModelConfirmation('');
      await load();
      toast('Model selection saved. Start a new conversation to use the updated setup.');
    } catch (error) { setError(errorText(error)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }

  return <div className="space-y-5">
    <div className="flex items-center justify-between gap-3"><p className="text-xs md:text-sm text-muted">Configure Hermes and your independent bots.</p><button className={buttonClass} disabled={busy || loading} onClick={load}>Refresh</button></div>
    {error && <Notice error>{error}</Notice>}
    <Field label="Bot"><select className={inputClass} disabled={busy || loading} value={profile} onChange={event => { loadSequence.current++; setProfile(event.target.value); setSnapshot(null); setSecret(''); setProvider(''); setModel(''); setBaseUrl(''); setEndpointName(''); setEndpointSecret(''); setModelConfirmation(''); }}>
      <option value="default">Main</option>{profiles.filter(item => item.name !== 'default' && (!item.state || item.state === 'active')).map(item => <option key={item.name} value={item.name}>{item.display_name || item.name}</option>)}
    </select></Field>
    {section === 'general' && <div className="space-y-5"><AppearanceSettings /><BotPreferences key={profile} profile={profile} /></div>}
    {visited.has('models') && <div hidden={section !== 'models'} className="space-y-5">
    <HermesSavedProviders key={profile} profile={profile} botName={profiles.find(item => item.name === profile)?.display_name || (profile === 'default' ? 'Main' : profile)} revision={configRevision} busy={busy || loading} onConnected={load} onChooseModel={value => {
      setProvider(value); setModel(''); setKey(providerCredentialName(credentials, value)); setSecret(''); setBaseUrl(''); setEndpointName(''); setEndpointSecret(''); setModelConfirmation('');
      modelForm.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }} />
    <section ref={modelForm} className={`${cardClass} space-y-3.5`}><h2 className="text-base md:text-lg font-semibold text-ink">Connect a model</h2>
      <HermesModelPicker key={`${profile}:${configRevision}`} profile={profile} provider={provider} model={model} busy={busy || loading}
        chooseProvider={(value, keyEnv) => { setProvider(value); setModel(''); setBaseUrl(''); setEndpointName(''); setEndpointSecret(''); setModelConfirmation(''); setSecret(''); setKey(providerCredentialName(credentials, value, keyEnv)); }}
        chooseModel={value => { setModel(value); setModelConfirmation(''); }} />
      <Field label="Credential name" hint="Provider and tool credentials are stored by Hermes for the selected bot."><input className={inputClass} list="hermes-credential-names" value={key} disabled={busy} onChange={event => setKey(event.target.value)} /><datalist id="hermes-credential-names">{Object.keys(credentials).map(name => <option key={name} value={name} />)}</datalist></Field>
      <Field label="API key" hint={credentials[key]?.is_set ? 'A credential is already stored. Leave it unchanged unless you intend to replace it.' : 'Enter the key supplied by your provider.'}><input className={inputClass} type="password" autoComplete="new-password" value={secret} disabled={busy} onChange={event => setSecret(event.target.value)} /></Field>
      <button className={buttonClass} disabled={busy || !key.trim() || !secret.trim()} onClick={() => runAction(async () => { const result = await submit('credentials', { key: key.trim(), value: secret }) as { ok?: boolean }; if (result.ok !== true) throw new Error('Hermes did not confirm the saved credential. Refresh before retrying.'); setSecret(''); }, 'Credential saved for this bot.')}>Save credential</button>
      <Field label="Custom endpoint (optional)" hint="For a local or compatible provider, enter its API base URL. Leave blank to use the provider’s normal endpoint."><input className={inputClass} value={baseUrl} placeholder="http://localhost:8000/v1" disabled={busy} onChange={event => { setBaseUrl(event.target.value); setModelConfirmation(''); }} /></Field>
      {baseUrl.trim() && ['custom', 'local'].includes(provider.trim().toLowerCase()) && <div className="space-y-3">
        <Field label="Endpoint name" hint="Give this endpoint a distinct name. Reusing a name updates that saved endpoint."><input className={inputClass} value={endpointName} disabled={busy} onChange={event => { setEndpointName(event.target.value); setModelConfirmation(''); }} /></Field>
        <Field label="Custom endpoint API key (optional)" hint="This key belongs to this endpoint. Leave blank for a keyless local server or to preserve its existing credential."><input className={inputClass} type="password" autoComplete="new-password" value={endpointSecret} disabled={busy} onChange={event => { setEndpointSecret(event.target.value); setModelConfirmation(''); }} /></Field>
      </div>}
      <button className={buttonClass} disabled={busy || !provider.trim() || !model.trim() || Boolean(baseUrl.trim() && ['custom', 'local'].includes(provider.trim().toLowerCase()) && !endpointName.trim())} onClick={() => selectModel()}>Select model</button>
      {modelConfirmation && <div className="space-y-2"><Notice>{modelConfirmation}</Notice><button className={buttonClass} disabled={busy} onClick={() => selectModel(true)}>Confirm this model selection</button></div>}
    </section>
    {visited.has('models') && <HermesAccountsSettings profile={profile} />}
    </div>}
    {visited.has('tools') && <div hidden={section !== 'tools'}><HermesToolsSettings profile={profile} /></div>}
    {visited.has('integrations') && <div hidden={section !== 'integrations'} className="space-y-5"><HermesPluginsSettings profile={profile} /><HermesMcpSettings profile={profile} /></div>}
    {visited.has('memory') && <div hidden={section !== 'memory'}><HermesMemorySettings profile={profile} /></div>}
    {visited.has('learning') && <div hidden={section !== 'learning'}><HermesLearningSettings profile={profile} /></div>}
    {visited.has('channels') && <div hidden={section !== 'channels'}><HermesChannelsSettings profile={profile} /></div>}
    {visited.has('skills') && <div hidden={section !== 'skills'}><HermesWorkshop profile={profile} includeMemory={false} /></div>}
    {visited.has('automation') && <div hidden={section !== 'automation'} className="space-y-5">{section === 'automation' && <HermesAutonomySettings key={profile} profile={profile} />}<HermesGoals profile={profile} /></div>}
    <section hidden={section !== 'agents'} className={`${cardClass} space-y-3`}><h2 className="text-sm text-ink">Create a bot</h2>
      <Field label="Name" hint="Use lowercase letters, digits, underscores or hyphens; start with a letter."><input className={inputClass} value={newName} disabled={busy} onChange={event => setNewName(event.target.value)} /></Field>
      <Field label="Personality and instructions"><textarea className={inputClass} rows={4} value={soul} disabled={busy} onChange={event => setSoul(event.target.value)} /></Field>
      <Field label="Bot role" hint="Shown in About and shared with the bot roster. Optional; leave blank if this bot has no specific role."><textarea className={inputClass} rows={2} maxLength={2000} value={newRole} disabled={busy} onChange={event => setNewRole(event.target.value)} /></Field>
      <Notice>New bots have their own state. Creating one does not copy another bot’s private memories or channel credentials.</Notice>
      <button className={buttonClass} disabled={busy || !/^[a-z][a-z0-9_-]{0,63}$/.test(newName) || newName === 'default'} onClick={() => runAction(async () => { await request('/api/hermes/profiles', { method: 'POST', body: JSON.stringify({ name: newName, soul, description: newRole.trim() }) }); setNewName(''); setNewRole(''); setSoul(''); }, 'Bot created. Select it above to connect its model and credentials.')}>Create bot</button>
      {profiles.filter(item => item.state === 'setup_required').map(item => <div key={item.name} className="space-y-2">
        <Notice>Setup for {item.name} did not finish. Confirm that its existing Hermes profile should be used as your bot; this assigns its working directory and private listener credential. No model key or memory is copied from another bot.</Notice>
        <button className={buttonClass} disabled={busy} onClick={() => runAction(() => request(`/api/hermes/profiles/${encodeURIComponent(item.name)}/finish-setup`, { method: 'POST', body: JSON.stringify({ confirmExisting: true }) }), `Setup finished for ${item.name}.`)}>Confirm profile and finish setup: {item.name}</button>
      </div>)}
    </section>
    <div hidden={section !== 'advanced'} className="space-y-5">
    {loading && !snapshot ? <Skeleton className="h-64 w-full" /> : visited.has('advanced') && snapshot && schema ? <HermesConfigEditor key={`${profile}:${configRevision}`} snapshot={snapshot} schema={schema} busy={busy} onSave={async next => {
      const changes = hermesConfigChanges(snapshot, next);
      if (!Object.keys(changes).length) return;
      await action(() => submit('config', { config: changes }), 'Settings saved. Some Hermes settings take effect on a new session or after a runtime restart.');
    }} /> : null}
    <details className={`${cardClass} group`}>
      <summary className="cursor-pointer list-none text-sm font-medium text-ink">Advanced: raw Hermes JSON</summary>
      <div className="mt-3 space-y-3">
        <Notice>Use this only for fields that need manual editing. Stored credential placeholders are preserved; use the credential form to replace a key. A removed JSON field is not a reset.</Notice>
        <textarea aria-label="Hermes configuration JSON" className={`${inputClass} font-mono`} rows={16} value={configText} disabled={busy || loading || !snapshot} onChange={event => setConfigText(event.target.value)} />
        <button className={buttonClass} disabled={busy || loading || !snapshot} onClick={() => runAction(async () => {
          const config: unknown = JSON.parse(configText);
          if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Configuration must be a JSON object.');
          const changes = hermesConfigChanges(snapshot!, config as HermesConfig);
          if (Object.keys(changes).length) await submit('config', { config: changes });
        }, 'Settings saved. Some Hermes settings take effect on a new session or after a runtime restart.')}>Save raw settings</button>
      </div>
    </details>
    </div>
  </div>;
}

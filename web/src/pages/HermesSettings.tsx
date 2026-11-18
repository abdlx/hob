import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, chatApi } from '../services/api';
import { hermesConfigChanges } from '../services/hermes-settings';
import type { HermesConfig, HermesCredential } from '../services/hermes-settings';
import { buttonClass, cardClass, Field, inputClass, Notice, Skeleton } from '../components/WorkspaceUI';
import { errorText } from '../components/workspaceUtils';
import { useToast } from '../context/ToastContext';
import { HermesSavedProviders } from '../components/HermesSavedProviders';
import { HermesAddProviderWizard } from '../components/HermesAddProviderWizard';
import { HermesAccountsSettings, HermesChannelsSettings, HermesToolsSettings } from '../components/HermesIntegrations';
import { HermesMcpSettings } from '../components/HermesMcpSettings';
import { HermesMemorySettings } from '../components/HermesMemorySettings';
import { HermesTeamSettings } from '../components/HermesTeamSettings';
import { HobTeamWorkspace } from '../components/HobTeamWorkspace';
import { HermesLearningSettings } from '../components/HermesLearningSettings';
import { HermesConfigEditor } from '../components/HermesConfigEditor';
import type { HermesConfigSchema } from '../components/HermesConfigEditor';
import { Search, SlidersHorizontal, Grid2X2, KeyRound, Hand, MessageCircle, MonitorSmartphone, Paintbrush, Brain, Bot, CalendarClock, ChevronRight, Lightbulb } from 'lucide-react';
import { preference, savePreference, searchSettings, settingsSection, settingsSections } from '../services/settings-navigation';
import type { SettingsSection } from '../services/settings-navigation';
import { AppearanceSettings } from '../components/AppearanceSettings';
import { HermesPluginsSettings } from '../components/HermesPluginsSettings';
import { HermesAutonomySettings } from '../components/HermesAutonomySettings';
import { HermesGoals, HermesWorkshop } from './HermesWorkspace';
import { BotPreferences } from '../components/BotPreferences';
import { NotificationSettings } from '../components/NotificationSettings';
import { PortalVaultSettings } from '../components/PortalVaultSettings';

interface Profile { name: string; display_name?: string; description?: string; model?: string; provider?: string; state?: string }

export function HermesSettings({ initialProfile }: { initialProfile?: string } = {}) {
  const [profile, setProfile] = useState(() => initialProfile && /^[a-z][a-z0-9_-]{0,63}$/.test(initialProfile) ? initialProfile : chatApi.getProfile());
  const [section, setSection] = useState(() => settingsSection(preference('hob:settings-section', 'models')));
  const [visited, setVisited] = useState<Set<SettingsSection>>(() => new Set([section]));
  const [search, setSearch] = useState('');
  const [mobileCategory, setMobileCategory] = useState(false);
  useEffect(() => {
    const back = (event: Event) => { if (mobileCategory && window.matchMedia('(max-width: 767px)').matches) { event.preventDefault(); setMobileCategory(false); setSearch(''); } };
    window.addEventListener('hob:settings-back', back);
    return () => window.removeEventListener('hob:settings-back', back);
  }, [mobileCategory]);
  const matches = searchSettings(search);
  const current = settingsSections.find(item => item.id === section)!;
  const openCategory = (id: SettingsSection) => { setVisited(previous => new Set([...previous, id])); setSection(id); setMobileCategory(true); savePreference('hob:settings-section', id); };
  const icons = { general: Paintbrush, models: KeyRound, agents: Bot, tools: MonitorSmartphone, vault: KeyRound, integrations: Grid2X2, skills: Lightbulb, memory: Brain, learning: Hand, automation: CalendarClock, channels: MessageCircle, advanced: SlidersHorizontal };
  const groups: SettingsSection[][] = [['general'], ['models', 'agents', 'tools', 'vault', 'integrations', 'channels'], ['skills', 'memory', 'learning', 'automation'], ['advanced']];
  return <div className={`hob-settings-root ${mobileCategory ? 'hob-settings-detail' : ''}`}>
    <div className="settings-workspace hob-settings-layout">
      <aside className="hob-settings-directory">
        <div className="relative mb-4"><Search size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-muted" /><input aria-label="Find settings category" className={`${inputClass} pl-11`} placeholder="Find settings..." value={search} onChange={event => setSearch(event.target.value)} /></div>
        <nav aria-label="Settings categories">{groups.map((group, index) => {
          const items = matches.filter(item => group.includes(item.id));
          return items.length > 0 && <div className="hob-settings-group" key={index}>{items.map(item => {
            const Icon = icons[item.id];
            return <button key={item.id} aria-label={item.title} aria-current={section === item.id && mobileCategory ? 'page' : undefined} onClick={() => openCategory(item.id)}><Icon size={24} strokeWidth={1.7} /><span><span className="hob-settings-category-name">{item.title}</span><small>{item.description}</small></span><ChevronRight size={20} /></button>;
          })}</div>;
        })}</nav>
        {matches.length === 0 && <p className="py-2 text-sm text-muted">No matching category. Search all native fields in Advanced configuration.</p>}
      </aside>
      <div className="hob-settings-content min-w-0">
        {initialProfile && mobileCategory && <button type="button" className="md:hidden mb-3 text-accent" onClick={() => setMobileCategory(false)}>‹ Settings</button>}
        <div className="mb-5"><h2 className="text-xl font-semibold text-ink">{current.title}</h2><p className="mt-1 text-sm text-muted">{current.description}</p></div>
        {section === 'vault' ? <PortalVaultSettings initialProfile={profile} /> : <ProfileSettings key={profile} profile={profile} setProfile={value => { setVisited(new Set([section])); setProfile(value); }} section={section} visited={visited} />}
      </div>
    </div>
  </div>;
}

function ProfileSettings({ profile, setProfile, section, visited }: { profile: string; setProfile: (value: string) => void; section: SettingsSection; visited: Set<SettingsSection> }) {
  const { toast } = useToast();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [available, setAvailable] = useState<Profile[]>([]);
  const mounted = useRef(true);
  const modelForm = useRef<HTMLElement>(null);
  const pending = useRef(false);
  const [snapshot, setSnapshot] = useState<HermesConfig | null>(null);
  const [schema, setSchema] = useState<HermesConfigSchema | null>(null);
  const [configRevision, setConfigRevision] = useState(0);
  const [configText, setConfigText] = useState('');
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
      const roster = await request<{ profiles: Profile[]; available?: Profile[] }>('/api/hermes/profiles');
      if (sequence !== loadSequence.current) return;
      setProfiles(roster.profiles);
      setAvailable(roster.available ?? []);
      const [config, , configSchema] = await Promise.all([
        request<HermesConfig>(scoped('config')),
        request<Record<string, HermesCredential>>(scoped('credentials')),
        request<HermesConfigSchema>(scoped('config/schema')),
      ]);
      if (sequence !== loadSequence.current) return;
      setSnapshot(config);
      setSchema(configSchema);
      setConfigRevision(value => value + 1);
      setConfigText(JSON.stringify(config, null, 2));
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
  const adopt = (name: string) => runAction(
    () => request('/api/hermes/profiles/adopt', { method: 'POST', body: JSON.stringify({ name }) }),
    `Adopted ${name}. Select it above to connect its model and credentials.`,
  );
  const removeRecord = (name: string) => runAction(
    () => request(`/api/hermes/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    `Removed the dashboard record for ${name}.`,
  );
  const staleProfiles = profiles.filter(item => item.state === 'unavailable');
  return <div className="space-y-5">
    <div className="flex items-center justify-between gap-3"><p className="min-w-0 text-xs md:text-sm text-muted">Configure Hermes and your independent bots.</p><button className={`${buttonClass} shrink-0`} disabled={busy || loading} onClick={load}>Refresh</button></div>
    {error && <Notice error>{error}</Notice>}
    <Field label="Bot"><select className={inputClass} disabled={busy || loading} value={profile} onChange={event => { loadSequence.current++; setProfile(event.target.value); setSnapshot(null); }}>
      <option value="default">{profiles.find(item => item.name === 'default')?.display_name || 'Main'}</option>{profiles.filter(item => item.name !== 'default' && (!item.state || item.state === 'active')).map(item => <option key={item.name} value={item.name}>{item.display_name || item.name}</option>)}
    </select></Field>
    {section === 'general' && <div className="space-y-5"><AppearanceSettings /><NotificationSettings /><BotPreferences key={profile} profile={profile} /></div>}
    {visited.has('models') && <div hidden={section !== 'models'} className="space-y-5">
    <HermesSavedProviders key={profile} profile={profile} botName={profiles.find(item => item.name === profile)?.display_name || (profile === 'default' ? 'Main' : profile)} revision={configRevision} busy={busy || loading} onConnected={load} onChooseModel={() => {
      modelForm.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }} />
    <section ref={modelForm} className="space-y-4">
      <HermesAddProviderWizard
        profile={profile}
        botName={profiles.find(item => item.name === profile)?.display_name || (profile === 'default' ? 'Main' : profile)}
        busy={busy || loading}
        onSave={async (newProvider, newModel, newKey, newSecret, newBaseUrl) => {
          if (newSecret) {
            await submit('credentials', { key: newKey, value: newSecret });
          }
          await submit('model', {
            scope: 'main',
            provider: newProvider,
            model: newModel,
            ...(newBaseUrl ? { base_url: newBaseUrl } : {})
          }, 'POST');
          await load();
          window.dispatchEvent(new CustomEvent('hob:reconnect'));
          toast('Model provider saved successfully!');
        }}
      />
    </section>
    {visited.has('models') && <HermesAccountsSettings profile={profile} />}
    </div>}
    {visited.has('tools') && <div hidden={section !== 'tools'}><HermesToolsSettings profile={profile} /></div>}
    {visited.has('integrations') && <div hidden={section !== 'integrations'} className="space-y-5"><HermesPluginsSettings profile={profile} /><HermesMcpSettings profile={profile} /></div>}
    {visited.has('memory') && <div hidden={section !== 'memory'} className="space-y-5">{profile === 'default' && <HermesTeamSettings />}<HobTeamWorkspace key={profile} profile={profile} /><HermesMemorySettings profile={profile} /></div>}
    {visited.has('learning') && <div hidden={section !== 'learning'}><HermesLearningSettings profile={profile} /></div>}
    {visited.has('channels') && <div hidden={section !== 'channels'}><HermesChannelsSettings profile={profile} /></div>}
    {visited.has('skills') && <div hidden={section !== 'skills'}><HermesWorkshop profile={profile} includeMemory={false} /></div>}
    {visited.has('automation') && <div hidden={section !== 'automation'} className="space-y-5">{section === 'automation' && <HermesAutonomySettings key={profile} profile={profile} />}<HermesGoals profile={profile} /></div>}
    <section hidden={section !== 'agents'} className={`${cardClass} space-y-3`}>
      {staleProfiles.length > 0 && <div className="space-y-2 border-b border-hair pb-4">
        <h2 className="text-sm text-ink">Missing Hermes profiles</h2>
        <p className="text-xs text-muted">These dashboard records have no matching profile in Hermes, so the app hides them. The team relay still advertises them until the record is removed. With the default profile sync, HOB retires them automatically after a second check; removing one here does it immediately. Either way, nothing is deleted from disk.</p>
        {staleProfiles.map(item => <div key={item.name} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm text-ink">{item.display_name || item.name}</p>
            <p className="truncate text-xs text-muted">Profile {item.name} is missing</p>
          </div>
          <button className={`${buttonClass} shrink-0`} disabled={busy} onClick={() => removeRecord(item.name)}>Remove record</button>
        </div>)}
      </div>}
      {available.length > 0 && <div className="space-y-2 border-b border-hair pb-4">
        <h2 className="text-sm text-ink">Adopt an existing profile</h2>
        <p className="text-xs text-muted">These profiles exist in Hermes but are not in the dashboard. Adoption keeps their prompts, model and sessions, and gives each one its own HOB workspace and relay identity. Nothing is copied from another bot.</p>
        {available.map(item => <div key={item.name} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-edge px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm text-ink">{item.name}</p>
            <p className="truncate text-xs text-muted">{item.description || item.model || 'Existing Hermes profile'}</p>
          </div>
          <button className={`${buttonClass} shrink-0`} disabled={busy} onClick={() => adopt(item.name)}>Adopt {item.name}</button>
        </div>)}
      </div>}
      <h2 className="text-sm text-ink">Create a bot</h2>
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

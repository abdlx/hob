import { useCallback, useEffect, useRef, useState } from 'react';
import { hermesSetupApi, setupLink } from '../services/hermes-setup';
import { useToast } from '../context/ToastContext';
import { buttonClass, cardClass, ConfirmButton, Field, inputClass, Notice, Skeleton } from './WorkspaceUI';
import { errorText } from './workspaceUtils';

const write = (method: string, value?: unknown) => ({ method, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
function useSetup<T>(profile: string, route: string) {
  const { toast } = useToast();
  const [data, setData] = useState<T | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const revision = useRef(0), pending = useRef(false);
  const api = useCallback(<R,>(path: string, init: RequestInit = {}) => hermesSetupApi(profile)<R>(path, init), [profile]);
  const invalidate = useCallback(() => { revision.current++; }, []);
  const load = useCallback(async () => {
    const current = ++revision.current;
    try { const next = await api<T>(route); if (current === revision.current) { setData(next); setError(''); } }
    catch (error) { if (current === revision.current) setError(errorText(error)); }
  }, [api, route]);
  useEffect(() => { const timer = window.setTimeout(load, 0); return () => { invalidate(); window.clearTimeout(timer); }; }, [load, invalidate]);
  const action = async (work: () => Promise<string>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { const message = await work(); await load(); toast(message); }
    catch (error) { setError(errorText(error)); }
    finally { pending.current = false; setBusy(false); }
  };
  return { api, data, error, busy, load, action };
}

interface SetupField { key: string; prompt?: string; description?: string; help?: string; required?: boolean; is_set?: boolean; is_password?: boolean; is_list?: boolean; value?: string }
interface ToolProvider { name: string; status?: string; is_active?: boolean; env_vars: SetupField[]; capabilities?: string[]; post_setup?: string }
interface ToolMatrix { providers: ToolProvider[]; active_provider?: string; has_category: boolean; active_search_backend?: string; active_extract_backend?: string }
interface Tool { name: string; label: string; description: string; enabled: boolean; configured: boolean; platform_label?: string }

function ToolEditor({ profile, tool }: { profile: string; tool: Tool }) {
  const { api, data, error, busy, load, action } = useSetup<ToolMatrix>(profile, `tools/${tool.name}/config`);
  const [provider, setProvider] = useState(''), [env, setEnv] = useState<Record<string, string>>({}), [capability, setCapability] = useState('search');
  const row = data?.providers.find(item => item.name === provider);
  return <div className={`${cardClass} space-y-3`}><h3 className="text-sm text-ink">Configure {tool.label}</h3>{error && <Notice error>{error}</Notice>}
    {!data ? <div className="space-y-3"><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-2/3" /></div> : !data.has_category ? <Notice>This toolset needs no provider selection. Configure additional native settings in Advanced configuration if required.</Notice> : <>
      <p className="text-xs text-muted">Active provider: {data.active_provider || 'none'}</p>{tool.name === 'web' && <p className="text-xs text-muted">Search: {data.active_search_backend || 'native default'} · Extraction: {data.active_extract_backend || 'native default'}</p>}<Field label="Tool provider"><select className={inputClass} value={provider} disabled={busy} onChange={event => { setProvider(event.target.value); setEnv({}); }}><option value="">Choose a provider</option>{data.providers.map(item => <option key={item.name} value={item.name}>{item.name} · {item.status || (item.is_active ? 'active' : 'available')}</option>)}</select></Field>
      {row && <>{row.env_vars.map(field => <Field key={field.key} label={field.prompt || field.key} hint={`${field.is_set ? 'Stored; leave blank to keep it. ' : ''}${field.description || ''}`}><input className={inputClass} type="password" autoComplete="new-password" value={env[field.key] || ''} disabled={busy} onChange={event => setEnv(previous => ({ ...previous, [field.key]: event.target.value }))} /></Field>)}
        {row.env_vars.length > 0 && <button className={buttonClass} disabled={busy || !Object.values(env).some(value => value.trim())} onClick={() => action(async () => { await api(`tools/${tool.name}/credentials`, write('PUT', { env: Object.fromEntries(Object.entries(env).filter(([, value]) => value.trim())) })); setEnv({}); return 'Credential fields saved for this bot. Select the provider separately.'; })}>Save tool credentials</button>}
        {tool.name === 'web' && <Field label="Web capability"><select className={inputClass} value={capability} disabled={busy} onChange={event => setCapability(event.target.value)}>{['search', 'extract'].filter(item => !row.capabilities || row.capabilities.includes(item)).map(item => <option key={item} value={item}>{item}</option>)}</select></Field>}
        <button className={buttonClass} disabled={busy} onClick={() => action(async () => { const result = await api<{ needs_nous_auth?: boolean }>(`tools/${tool.name}/provider`, write('PUT', { provider: row.name, ...(tool.name === 'web' ? { capability } : {}) })); return result.needs_nous_auth ? 'Selection saved, but this managed provider still requires an entitled Nous account. Connect the account below; this tool is not ready yet.' : 'Provider selection saved. Start a new conversation to refresh its tools.'; })}>Select tool provider</button>
        {row.post_setup && <ConfirmButton disabled={busy} message={<>Run Hermes’s dependency setup for {row.name} on this server? This may download packages.</>} confirmLabel="Confirm setup" onConfirm={() => { void action(async () => { await api(`tools/${tool.name}/install`, write('POST', { key: row.post_setup, confirm: true })); return 'Native dependency setup started. Refresh provider status to check readiness; starting is not completion.'; }); }}>Set up native dependencies</ConfirmButton>}
      </>}
    </>}<button className={buttonClass} disabled={busy} onClick={load}>Refresh provider status</button></div>;
}

export function HermesToolsSettings({ profile }: { profile: string }) {
  const { api, data, error, busy, load, action } = useSetup<Tool[]>(profile, 'tools');
  const [selected, setSelected] = useState('');
  const tool = data?.find(item => item.name === selected);
  return <section className="space-y-3"><div className="flex justify-between"><h2 className="text-sm text-ink">Tools & providers</h2><button className={buttonClass} disabled={busy} onClick={load}>Refresh tools</button></div>{error && <Notice error>{error}</Notice>}<Notice>Tool choices and credentials belong to this bot. Native setup may install dependencies when enabling some tools. New conversations refresh their tool inventory.</Notice>
    <Field label="Toolset"><select className={inputClass} value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}><option value="">Choose a toolset</option>{data?.map(item => <option key={item.name} value={item.name}>{item.label} · {item.enabled ? 'enabled' : 'disabled'} · {item.configured ? 'configured' : 'setup needed'}</option>)}</select></Field>
    {tool && <><p className="text-xs text-muted">{tool.description} {tool.platform_label ? `(${tool.platform_label})` : ''}</p>{tool.enabled ? <button className={buttonClass} disabled={busy} onClick={() => action(async () => { await api(`tools/${tool.name}`, write('PUT', { enabled: false })); return 'Toolset disabled for this bot.'; })}>Disable toolset</button> : <ConfirmButton disabled={busy} message={<>Enable {tool.label} for this bot? Hermes may also install its native dependencies.</>} confirmLabel="Confirm enable" onConfirm={() => { void action(async () => { const result = await api<{ post_setup_started?: string }>(`tools/${tool.name}`, write('PUT', { enabled: true, confirm: true })); return result.post_setup_started ? 'Enabled. Native dependency setup is running; refresh status before relying on this tool.' : 'Toolset enabled. Start a new conversation to refresh its tools.'; }); }}>Enable toolset</ConfirmButton>}<ToolEditor key={`${profile}:${tool.name}`} profile={profile} tool={tool} /></>}
  </section>;
}

interface Channel { id: string; name: string; description: string; enabled: boolean; configured: boolean; state: string; docs_url?: string; env_vars: SetupField[] }

function ChannelEditor({ profile, channel, refresh }: { profile: string; channel: Channel; refresh: () => Promise<void> }) {
  const { api, error, busy, action } = useSetup<{ platforms: Channel[] }>(profile, 'channels');
  const [env, setEnv] = useState<Record<string, string>>({});
  const changes = Object.fromEntries(Object.entries(env).filter(([, value]) => value.trim()));
  return <div className={`${cardClass} space-y-3`}><h3 className="text-sm text-ink">{channel.name}</h3><p className="text-xs text-muted">{channel.description}</p><p className="text-xs text-muted">{channel.state || (channel.enabled ? 'enabled' : 'disabled')} · {channel.configured ? 'configured' : 'setup needed'}</p>{error && <Notice error>{error}</Notice>}
    {setupLink(channel.docs_url) && <a className={buttonClass} href={setupLink(channel.docs_url)} target="_blank" rel="noreferrer">Setup instructions</a>}
    {channel.env_vars.map(field => <Field key={field.key} label={`${field.prompt || field.key}${field.required ? ' *' : ''}`} hint={`${field.is_set ? 'Stored; leave blank to preserve. ' : ''}${field.help || field.description || ''}`}><input className={inputClass} type={field.is_list ? 'text' : 'password'} autoComplete="off" placeholder={field.is_list ? field.value || 'Comma-separated IDs' : undefined} value={env[field.key] || ''} disabled={busy} onChange={event => setEnv(previous => ({ ...previous, [field.key]: event.target.value }))} /></Field>)}
    <div className="flex gap-2 flex-wrap"><button className={buttonClass} disabled={busy || !Object.keys(changes).length} onClick={() => action(async () => { await api(`channels/${channel.id}`, write('PUT', { env: changes })); setEnv({}); await refresh(); return 'Channel fields saved. Connecting is a separate action.'; })}>Save channel fields</button>{channel.enabled ? <button className={buttonClass} disabled={busy} onClick={() => action(async () => { await api(`channels/${channel.id}`, write('PUT', { enabled: false })); await refresh(); return 'Channel disabled. The native gateway applies its own lifecycle rules.'; })}>Disconnect channel</button> : <ConfirmButton disabled={busy} message={<>Connect this bot to {channel.name}? Check its allowed-user IDs first. This makes the bot reachable through that service. Save any credential edits before connecting.</>} confirmLabel="Confirm connection" onConfirm={() => { void action(async () => { const result = await api<{ hot_served?: boolean }>(`channels/${channel.id}`, write('PUT', { enabled: true, confirm: true })); await refresh(); return result.hot_served ? 'Channel saved and native gateway reconciliation requested. Refresh to inspect live status.' : 'Channel saved. Native status may require a gateway restart; saving does not prove connectivity.'; }); }}>Connect channel</ConfirmButton>}<button className={buttonClass} disabled={busy} onClick={() => action(async () => { const result = await api<Record<string, unknown>>(`channels/${channel.id}/test`, write('POST', {})); return result.ok === true ? 'Connected. The native gateway reports this channel online.' : 'Not connected. Channel status: ' + String(result.state || 'unavailable') + '. Check the required fields and refresh status.'; })}>Test connection</button></div>
  </div>;
}

export function HermesChannelsSettings({ profile }: { profile: string }) {
  const { data, error, load } = useSetup<{ platforms: Channel[] }>(profile, 'channels');
  const [selected, setSelected] = useState(''); const channel = data?.platforms.find(item => item.id === selected);
  return <section className="space-y-3"><div className="flex justify-between"><h2 className="text-sm text-ink">Messaging channels</h2><button className={buttonClass} onClick={load}>Refresh channels</button></div>{error && <Notice error>{error}</Notice>}<Notice>Configure a bot’s messaging credentials and allowed users here. Deployment listeners are managed by the application and are excluded.</Notice><Field label="Channel"><select className={inputClass} value={selected} onChange={event => setSelected(event.target.value)}><option value="">Choose a channel</option>{data?.platforms.map(item => <option key={item.id} value={item.id}>{item.name} · {item.state || 'not connected'}</option>)}</select></Field>{channel && <ChannelEditor key={`${profile}:${channel.id}`} profile={profile} channel={channel} refresh={load} />}</section>;
}

interface Account { id: string; name: string; flow: string; disconnectable: boolean; disconnect_hint?: string; docs_url?: string; status: { logged_in?: boolean } }
interface Login { session_id: string; provider: string; user_code: string; verification_url: string; poll_interval?: number; status: string }

export function HermesAccountsSettings({ profile }: { profile: string }) {
  const { api, data, error, busy, load, action } = useSetup<{ providers: Account[] }>(profile, 'accounts');
  const [login, setLogin] = useState<Login | null>(null);
  const activeLogin = useRef<Login | null>(null);
  useEffect(() => {
    if (!login || login.status !== 'pending') return;
    let cancelled = false, timer: number;
    const poll = async () => {
      try {
        const result = await api<{ status: string }>(`accounts/${login.provider}/poll/${encodeURIComponent(login.session_id)}`);
        if (cancelled) return;
        if (result.status !== 'pending') { const next = { ...login, status: result.status }; activeLogin.current = next; setLogin(next); await load(); return; }
      } catch { if (!cancelled) { const next = { ...login, status: 'unavailable' }; activeLogin.current = next; setLogin(next); } return; }
      if (!cancelled) timer = window.setTimeout(poll, Math.min(30000, Math.max(2000, (login.poll_interval || 5) * 1000)));
    };
    timer = window.setTimeout(poll, 2000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [api, login, load]);
  const cancelPending = useCallback(() => { const current = activeLogin.current; if (current?.status === 'pending') void api(`accounts/sessions/${encodeURIComponent(current.session_id)}`, write('DELETE')).catch(() => undefined); }, [api]);
  useEffect(() => cancelPending, [cancelPending]);
  return <section className="space-y-3"><div className="flex justify-between"><h2 className="text-sm text-ink">Provider accounts</h2><button className={buttonClass} onClick={load}>Refresh accounts</button></div>{error && <Notice error>{error}</Notice>}{login && <Notice>Sign-in status: {login.status}. {login.status === 'pending' && <>Open the provider page and enter <strong className="select-text">{login.user_code}</strong>. {setupLink(login.verification_url) && <a className={buttonClass} href={setupLink(login.verification_url)} target="_blank" rel="noreferrer">Open sign-in page</a>} <button className={buttonClass} disabled={busy} onClick={() => action(async () => { await api(`accounts/sessions/${encodeURIComponent(login.session_id)}`, write('DELETE')); activeLogin.current = null; setLogin(null); return 'Sign-in cancellation requested. Refresh accounts to check whether a credential was already saved.'; })}>Cancel sign-in</button></>}{login.status === 'approved' && ' Hermes saved the credential for this bot. Select a model separately.'}{['unavailable', 'expired', 'error', 'denied'].includes(login.status) && ' Refresh accounts to inspect the saved state before starting again.'}</Notice>}
    {data?.providers.map(account => <div key={account.id} className={`${cardClass} space-y-2`}><h3 className="text-xs text-ink">{account.name} · {account.status.logged_in ? 'connected' : 'not connected'}</h3>{account.flow === 'device_code' ? <button className={buttonClass} disabled={busy || login?.status === 'pending'} onClick={() => action(async () => { const result = await api<Omit<Login, 'provider' | 'status'>>(`accounts/${account.id}/start`, write('POST', { confirm: true })); const next = { ...result, provider: account.id, status: 'pending' }; activeLogin.current = next; setLogin(next); return 'Sign-in started. Complete approval on the provider’s page.'; })}>Connect {account.name}</button> : <Notice>This provider requires sign-in through its own CLI; native Hermes has no dashboard login for it. An API-key provider can be configured above instead.</Notice>}{setupLink(account.docs_url) && <a className={buttonClass} href={setupLink(account.docs_url)} target="_blank" rel="noreferrer">Provider instructions</a>}{account.status.logged_in && account.disconnectable && <ConfirmButton tone="danger" disabled={busy} message={<>Remove this bot’s Hermes-managed {account.name} sign-in?</>} confirmLabel="Confirm disconnect" onConfirm={() => { void action(async () => { await api(`accounts/${account.id}`, write('DELETE', { confirm: true })); return 'Account disconnected for this bot.'; }); }}>Disconnect account</ConfirmButton>}</div>)}
  </section>;
}

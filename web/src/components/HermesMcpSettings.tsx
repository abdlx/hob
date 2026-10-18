import { useCallback, useEffect, useRef, useState } from 'react';
import { hermesSetupApi } from '../services/hermes-setup';
import { buttonClass, cardClass, ConfirmButton, Field, inputClass, Notice, Skeleton } from './WorkspaceUI';
import { errorText } from './workspaceUtils';
import { useToast } from '../context/ToastContext';
import { HermesMcpOAuth } from './HermesMcpOAuth';

interface Server { name: string; transport: string; auth?: string; enabled: boolean; source: string; plugin?: string; envKeys: string[]; argumentCount: number }
interface Probe { ok: boolean; error?: string; tools?: { name: string; description?: string }[]; prompts?: number; resources?: number }
type Decision = { kind: 'probe'; name: string } | { kind: 'create' };
const write = (method: string, value: unknown) => ({ method, body: JSON.stringify(value) });

export function HermesMcpSettings({ profile }: { profile: string }) {
  const api = useCallback(<T,>(route: string, init: RequestInit = {}) => hermesSetupApi(profile)<T>(route, init), [profile]);
  const [servers, setServers] = useState<Server[] | null>(null), [error, setError] = useState('');
  const { toast } = useToast();
  const [busy, setBusy] = useState(false), [form, setForm] = useState(false);
  const [name, setName] = useState(''), [transport, setTransport] = useState('http'), [endpoint, setEndpoint] = useState('');
  const [command, setCommand] = useState(''), [args, setArgs] = useState(''), [auth, setAuth] = useState('none'), [token, setToken] = useState('');
  const [env, setEnv] = useState<{ key: string; value: string }[]>([]), [probe, setProbe] = useState<{ name: string; result: Probe } | null>(null);
  const pending = useRef(false), mounted = useRef(true), revision = useRef(0);
  const invalidate = useCallback(() => { revision.current++; }, []);
  const load = useCallback(async () => {
    const current = ++revision.current;
    const result = await api<{ servers: Server[] }>('mcp');
    if (mounted.current && current === revision.current) setServers(result.servers);
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    void load().catch(error => { if (mounted.current) setError(errorText(error)); });
    return () => { mounted.current = false; invalidate(); };
  }, [load, invalidate]);
  const action = async (work: () => Promise<string>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { const result = await work(); await load(); if (mounted.current) toast(result); }
    catch (error) { try { await load(); } catch { /* Keep the original operation error. */ } if (mounted.current) setError(errorText(error)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const confirm = (selected: Decision) => action(async () => {
    if (selected.kind === 'create') {
      const variables = Object.fromEntries(env.filter(item => item.key).map(item => [item.key, item.value]));
      if (env.filter(item => item.key).length !== Object.keys(variables).length || env.some(item => !item.key && item.value)) throw new Error('Give each environment credential a unique name.');
      await api('mcp', write('POST', { name: name.trim(), confirm: true,
        ...(transport === 'http' ? { url: endpoint.trim(), auth, ...(auth === 'header' ? { bearer_token: token } : {}) }
          : { command: command.trim(), args: args.split(/\r?\n/).filter(Boolean), env: variables, auth: 'none' }) }));
      setToken(''); setEnv([]); setForm(false); setName(''); setArgs(''); setCommand(''); setEndpoint('');
      return 'MCP configuration saved by Hermes. New conversations can load it; connection has not been verified.';
    }
    const result = await api<Probe>(`mcp/${encodeURIComponent(selected.name)}/test`, write('POST', { confirm: true })); setProbe({ name: selected.name, result });
    return result.ok ? 'Native MCP connection and tool listing succeeded.' : 'Native MCP probe failed. Review the result below.';
  });
  return <section className={`${cardClass} space-y-3`}><div className="flex justify-between gap-2"><h2 className="text-sm text-ink">MCP connections</h2><div className="flex gap-2"><button className={buttonClass} disabled={busy} onClick={() => action(async () => { await load(); return 'MCP inventory refreshed.'; })}>Refresh MCP</button><button className={buttonClass} disabled={busy} onClick={() => setForm(true)}>Add MCP server</button></div></div>
    <Notice>Connections belong to this bot. Authorizing a server lets Hermes contact it or run its executable when needed. Local executables run where Hermes runs. MCP access is not an operating-system sandbox.</Notice>
    {error && <Notice error>{error}</Notice>}{servers === null && !error && <div className="space-y-3"><Skeleton className="h-5 w-1/3" /><Skeleton className="h-9 w-full" /></div>}{servers?.length === 0 && <Notice>No MCP connections for this bot.</Notice>}
    {form && <fieldset disabled={busy} className="space-y-3 border border-hair p-3 rounded-xl"><Field label="MCP server name"><input className={inputClass} value={name} onChange={event => setName(event.target.value)} placeholder="my-server" /></Field><Field label="MCP transport"><select className={inputClass} value={transport} onChange={event => { setTransport(event.target.value); setToken(''); }}><option value="http">Remote HTTP / SSE endpoint</option><option value="stdio">Local executable (stdio)</option></select></Field>
      {transport === 'http' ? <><Field label="MCP endpoint"><input className={inputClass} value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://example.com/mcp" /></Field><Field label="MCP authentication"><select className={inputClass} value={auth} onChange={event => { setAuth(event.target.value); setToken(''); }}><option value="none">None</option><option value="header">Bearer credential</option><option value="oauth">OAuth sign-in</option></select></Field>{auth === 'header' && <Field label="MCP bearer credential"><input type="password" autoComplete="new-password" className={inputClass} value={token} onChange={event => setToken(event.target.value)} /></Field>}<p className="text-xs text-muted">For OAuth, save the connection first, then choose Sign in to MCP server on its card.</p></> : <><Field label="MCP executable" hint="Executable path or name available on the Hermes host, such as npx. Arguments go below."><input className={inputClass} value={command} onChange={event => setCommand(event.target.value)} /></Field><Field label="MCP arguments" hint="One argument per line. Do not add shell quoting around an argument."><textarea className={inputClass} rows={4} value={args} onChange={event => setArgs(event.target.value)} /></Field>{env.map((item, index) => <div key={index} className="flex gap-2"><input aria-label={`MCP environment name ${index + 1}`} className={inputClass} value={item.key} placeholder="API_KEY" onChange={event => setEnv(env.map((entry, position) => position === index ? { ...entry, key: event.target.value } : entry))} /><input aria-label={`MCP environment value ${index + 1}`} type="password" autoComplete="new-password" className={inputClass} value={item.value} onChange={event => setEnv(env.map((entry, position) => position === index ? { ...entry, value: event.target.value } : entry))} /><button type="button" className={buttonClass} onClick={() => setEnv(env.filter((_, position) => position !== index))}>Remove field</button></div>)}<button type="button" className={buttonClass} disabled={env.length >= 128} onClick={() => setEnv([...env, { key: '', value: '' }])}>Add environment credential</button></>}
      <div className="flex gap-2"><ConfirmButton className={buttonClass} disabled={!name.trim() || !(transport === 'http' ? endpoint.trim() : command.trim()) || (transport === 'http' && auth === 'header' && !token.trim())} message={<>Authorize {name} for this bot? Hermes may connect to {transport === 'http' ? endpoint : command} and use its tools in future conversations.</>} confirmLabel="Confirm MCP authorization" onConfirm={() => { void confirm({ kind: 'create' }); }}>Review MCP authorization</ConfirmButton><button type="button" className={buttonClass} onClick={() => { setForm(false); setToken(''); setEnv([]); }}>Cancel MCP setup</button></div>
    </fieldset>}
    {servers?.map(server => <div key={server.name} className="space-y-2 rounded-xl border border-hair p-3"><h3 className="text-sm text-ink">{server.name}</h3><p className="text-xs text-muted">{server.transport} · {server.enabled ? 'enabled' : 'disabled'} · {server.auth || 'no HTTP authentication'} · {server.source}{server.plugin ? ` (${server.plugin})` : ''}</p>{server.envKeys.length > 0 && <p className="text-xs text-muted">Configured environment fields: {server.envKeys.join(', ')}. Values are hidden.</p>}<div className="flex flex-wrap gap-2"><ConfirmButton className={buttonClass} disabled={busy} message={<>Connect to {server.name} now to list its tools? This can launch its executable or send its configured credentials to its endpoint.</>} confirmLabel="Confirm MCP test" onConfirm={() => { void confirm({ kind: 'probe', name: server.name }); }}>Test connection</ConfirmButton>{server.source !== 'plugin' && <>{server.enabled ? <button className={buttonClass} disabled={busy} onClick={() => { void action(async () => { await api(`mcp/${encodeURIComponent(server.name)}/enabled`, write('PUT', { enabled: false })); return 'Disabled for future native sessions. Existing sessions may need restarting.'; }); }}>Disable MCP</button> : <ConfirmButton className={buttonClass} disabled={busy} confirmLabel="Enable" message={`Authorize ${server.name} for future native sessions?`} onConfirm={() => { void action(async () => { await api(`mcp/${encodeURIComponent(server.name)}/enabled`, write('PUT', { enabled: true, confirm: true })); return 'Enabled for future native sessions. Probe separately to verify connectivity.'; }); }}>Enable MCP</ConfirmButton>}<ConfirmButton className={buttonClass} disabled={busy} tone="danger" confirmLabel="Remove" message={`Remove ${server.name} from this bot’s configuration? Reconnecting requires its setup details again.`} onConfirm={() => { void action(async () => { await api(`mcp/${encodeURIComponent(server.name)}`, write('DELETE', { confirm: true })); if (probe?.name === server.name) setProbe(null); return 'This bot’s MCP configuration was removed.'; }); }}>Remove MCP</ConfirmButton></>}</div>{server.auth === 'oauth' && server.transport !== 'stdio' && server.source !== 'plugin' && <HermesMcpOAuth key={`${profile}:${server.name}`} profile={profile} name={server.name} />}</div>)}
    {probe && <div className="space-y-2"><h3 className="text-sm text-ink">{probe.name} connection result</h3>{probe.result.ok ? <><p className="text-xs text-muted">{probe.result.tools?.length || 0} tools · {probe.result.prompts || 0} prompts · {probe.result.resources || 0} resources</p>{probe.result.tools?.map(tool => <p key={tool.name} className="text-xs text-muted">{tool.name}{tool.description ? `: ${tool.description}` : ''}</p>)}</> : <Notice error>{probe.result.error}</Notice>}</div>}
  </section>;
}

import { useState } from 'react';
import { apiFetch } from '../services/api';
import { useChat } from '../context/ChatContext';
import { buttonClass, cardClass, Field, inputClass, Notice } from './WorkspaceUI';
import { errorText } from './workspaceUtils';
import { SetupWizard } from './SetupWizard';

interface Plugin { id: string; name: string; installed: boolean; enabled: boolean; description?: string; state?: string; removable?: boolean }
interface RuntimeChoice { agentRuntime: { id: string }; available?: boolean; manualSelectionAllowed?: boolean; unavailableReason?: string }
interface Model { id: string; name: string; provider: string; available?: boolean; manualSelectionAllowed?: boolean; agentRuntime?: { id: string }; runtimeChoices?: RuntimeChoice[] }
interface ProviderCapability { provider: string; loginOptions?: { id: string; label: string; kind: string; hint?: string }[] }
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /apiKey|password|secret|accessToken|refreshToken/i.test(key) ? '••••••••' : redact(item)]));
  return value;
}
export function SettingsActions({ section }: { section: string }) {
  const { agent, refresh, updateAgent } = useChat();
  const [provider, setProvider] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [channel, setChannel] = useState('');
  const [accountId, setAccountId] = useState('');
  const [source, setSource] = useState('official');
  const [pluginName, setPluginName] = useState('');
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [canMutate, setCanMutate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<unknown>(null);
  const [qr, setQr] = useState('');
  const [removeId, setRemoveId] = useState('');
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState(agent?.model || '');
  const [runtime, setRuntime] = useState('');
  const [capabilities, setCapabilities] = useState<ProviderCapability[]>([]);
  const [loginChoice, setLoginChoice] = useState('');
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    setBusy(true); setError(''); setResult(null);
    try {
      const data = await apiFetch<Record<string, unknown>>('/api/rpc', { method: 'POST', body: JSON.stringify({ method, params }) });
      if (method === 'plugins.list') { setPlugins((data.plugins || []) as Plugin[]); setCanMutate(data.mutationAllowed !== false); }
      if (method === 'models.authSetApiKey') setApiKey('');
      if (method === 'models.list') setModels((data.models || []) as Model[]);
      if (method === 'models.authStatus') setCapabilities((data.providerCapabilities || []) as ProviderCapability[]);
      if (typeof data.qrDataUrl === 'string') setQr(data.qrDataUrl);
      setResult(redact(data));
      if (['plugins.install', 'plugins.uninstall', 'plugins.setEnabled'].includes(method)) {
        const catalog = await apiFetch<{ plugins: Plugin[]; mutationAllowed: boolean }>('/api/rpc', { method: 'POST', body: JSON.stringify({ method: 'plugins.list', params: {} }) }); setPlugins(catalog.plugins); setCanMutate(catalog.mutationAllowed);
      }
      await refresh();
    } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  };
  const channelParams = { channel, ...(accountId ? { accountId } : {}) };
  const selectedModel = models.find((item) => (item.id.startsWith(`${item.provider}/`) ? item.id : `${item.provider}/${item.id}`) === model);
  const runtimeChoices = selectedModel ? [...new Map([
    ...(selectedModel.agentRuntime ? [{ agentRuntime: selectedModel.agentRuntime, available: selectedModel.available, manualSelectionAllowed: selectedModel.manualSelectionAllowed }] : []),
    ...(selectedModel.runtimeChoices || []),
  ].map((choice) => [choice.agentRuntime.id, choice])).values()] : [];
  const preferredRuntime = runtimeChoices.find((choice) => choice.agentRuntime.id === selectedModel?.agentRuntime?.id && choice.unavailableReason !== 'unsupported-runtime' && choice.manualSelectionAllowed !== false);
  const selectedRuntime = runtime || preferredRuntime?.agentRuntime.id || runtimeChoices.find((choice) => choice.unavailableReason !== 'unsupported-runtime' && choice.manualSelectionAllowed !== false)?.agentRuntime.id;
  const runtimeAllowed = !runtimeChoices.length || runtimeChoices.some((choice) => choice.agentRuntime.id === selectedRuntime && choice.unavailableReason !== 'unsupported-runtime' && choice.manualSelectionAllowed !== false);
  if (!['models', 'connectors', 'channels', 'gateway'].includes(section)) return null;
  return <div className={`${cardClass} space-y-3`}><h3 className="text-[13px] text-[#d8c6aa]">{section === 'models' ? 'Provider credentials' : section === 'connectors' ? 'Manage connectors' : section === 'channels' ? 'Channel connection' : 'Gateway connection'}</h3>{error && <Notice error>{error}</Notice>}
    {section === 'models' && <><Field label="Provider" hint="For example: anthropic, openai, google."><input className={inputClass} value={provider} onChange={(event) => setProvider(event.target.value)} /></Field><Field label="API key" hint="Credentials are stored by OpenClaw for the selected agent."><input className={inputClass} type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></Field><div className="flex flex-wrap gap-2"><button className={buttonClass} disabled={busy || !provider.trim() || !apiKey.trim()} onClick={() => rpc('models.authSetApiKey', { provider: provider.trim(), apiKey, agentId: agent?.id })}>Save credential</button><button className={buttonClass} disabled={busy} onClick={() => rpc('models.authStatus', { agentId: agent?.id })}>Check credentials</button><button className={buttonClass} disabled={busy || !provider.trim()} onClick={() => rpc('models.probe', { provider: provider.trim(), agentId: agent?.id })}>Test model access</button><button className={buttonClass} disabled={busy} onClick={() => rpc('models.list', { agentId: agent?.id, view: 'all', includeDetails: true })}>Load models</button></div>{models.length > 0 && <><Field label="Agent model"><select className={inputClass} value={model} onChange={(event) => { setModel(event.target.value); setRuntime(''); }}><option value="">Choose a model</option>{models.map((item) => { const reference = item.id.startsWith(`${item.provider}/`) ? item.id : `${item.provider}/${item.id}`; return <option key={reference} value={reference} disabled={item.manualSelectionAllowed === false && !(item.runtimeChoices || []).some((choice) => choice.manualSelectionAllowed !== false && choice.unavailableReason !== 'unsupported-runtime')}>{item.name} · {item.provider}{item.available === false ? ' (credentials required)' : ''}</option>; })}</select></Field>{runtimeChoices.length > 0 && <Field label="Agent runtime"><select className={inputClass} value={selectedRuntime || ''} onChange={(event) => setRuntime(event.target.value)}>{runtimeChoices.map((choice) => <option key={choice.agentRuntime.id} value={choice.agentRuntime.id} disabled={choice.unavailableReason === 'unsupported-runtime' || choice.manualSelectionAllowed === false}>{choice.agentRuntime.id}{choice.unavailableReason === 'unsupported-runtime' ? ' (unsupported)' : choice.available === false ? ' (credentials required)' : ''}</option>)}</select></Field>}<button className={buttonClass} disabled={busy || !model || !runtimeAllowed} onClick={async () => { setBusy(true); setError(''); try { await updateAgent({ id: agent?.id, model, ...(selectedRuntime ? { agentRuntime: selectedRuntime } : {}) }); await refresh(); setResult({ model, agentRuntime: selectedRuntime, saved: true }); } catch (error) { setError(errorText(error)); } finally { setBusy(false); } }}>Use this model</button></>}{capabilities.some((item) => item.loginOptions?.length) && <Field label="Provider sign-in"><select className={inputClass} value={loginChoice} onChange={(event) => setLoginChoice(event.target.value)}><option value="">Choose a sign-in method</option>{capabilities.flatMap((item) => (item.loginOptions || []).map((option) => <option key={option.id} value={option.id}>{item.provider} · {option.label}</option>))}</select></Field>}{loginChoice && <SetupWizard key={loginChoice} authChoice={loginChoice} />}</>}
    {section === 'connectors' && <><button className={buttonClass} disabled={busy} onClick={() => rpc('plugins.list')}>Load installed & available connectors</button><div className="flex flex-wrap gap-3"><Field label="Install source"><select className={inputClass} value={source} onChange={(event) => setSource(event.target.value)}><option value="official">Official plugin</option><option value="clawhub">ClawHub package</option><option value="npm">npm package</option></select></Field><div className="flex-1 min-w-[180px]"><Field label="Plugin or package name"><input className={inputClass} value={pluginName} onChange={(event) => setPluginName(event.target.value)} /></Field></div></div><button className={buttonClass} disabled={busy || !canMutate || !pluginName.trim()} onClick={() => rpc('plugins.install', { source, [source === 'official' ? 'pluginId' : source === 'npm' ? 'spec' : 'packageName']: pluginName.trim() })}>Install connector</button>{plugins.map((plugin) => <div key={plugin.id} className="rounded-xl border border-[#27211b] p-3 space-y-2"><div className="flex justify-between gap-3"><span className="text-[12px]">{plugin.name}</span><span className="text-[10px] text-[#9a8971]">{plugin.state}</span></div><p className="text-[10px] text-[#80766a]">{plugin.description}</p><div className="flex flex-wrap gap-2"><button className={buttonClass} disabled={busy} onClick={() => rpc('plugins.inspect', { pluginId: plugin.id })}>Details</button>{plugin.installed && <button className={buttonClass} disabled={busy || !canMutate} onClick={() => rpc('plugins.setEnabled', { pluginId: plugin.id, enabled: !plugin.enabled })}>{plugin.enabled ? 'Disable' : 'Enable'}</button>}{plugin.removable && <button className={buttonClass} disabled={busy || !canMutate} onClick={() => setRemoveId(plugin.id)}>Uninstall</button>}</div>{removeId === plugin.id && <div className="flex gap-2 text-[11px] items-center"><span>Remove this connector?</span><button className={buttonClass} disabled={busy} onClick={async () => { await rpc('plugins.uninstall', { pluginId: plugin.id }); setRemoveId(''); }}>Remove</button><button className={buttonClass} onClick={() => setRemoveId('')}>Cancel</button></div>}</div>)}</>}
    {section === 'channels' && <><Field label="Channel" hint="Use the channel ID from your OpenClaw configuration, such as telegram, discord, or whatsapp."><input className={inputClass} value={channel} onChange={(event) => setChannel(event.target.value)} /></Field><Field label="Account ID (optional)"><input className={inputClass} value={accountId} onChange={(event) => setAccountId(event.target.value)} /></Field><div className="flex flex-wrap gap-2"><button className={buttonClass} disabled={busy} onClick={() => rpc('channels.status', { probe: true })}>Check status</button><button className={buttonClass} disabled={busy || !channel} onClick={() => rpc('channels.start', channelParams)}>Connect</button><button className={buttonClass} disabled={busy || !channel} onClick={() => rpc('channels.stop', channelParams)}>Disconnect</button><button className={buttonClass} disabled={busy || !channel} onClick={() => rpc('web.login.start', channelParams)}>Start QR login</button><button className={buttonClass} disabled={busy || !channel} onClick={() => rpc('web.login.wait', { ...channelParams, timeoutMs: 1000 })}>Check login</button></div>{qr && <img className="w-44 h-44 bg-white rounded-xl p-2" src={qr} alt="Scan with your messaging app to connect" />}</>}
    {section === 'gateway' && <><div className="flex flex-wrap gap-2"><button className={buttonClass} disabled={busy} onClick={() => rpc('health')}>Check gateway health</button><button className={buttonClass} disabled={busy} onClick={() => rpc('secrets.reload')}>Reload credentials</button><button className={buttonClass} disabled={busy} onClick={async () => { setBusy(true); try { await apiFetch('/api/auth/logout', { method: 'POST' }); window.dispatchEvent(new Event('muse:unauthorized')); } catch (error) { setError(errorText(error)); } finally { setBusy(false); } }}>Sign out</button></div></>}
    {busy && <Notice>Waiting for OpenClaw…</Notice>}{result !== null && <details open className="text-[11px] text-[#9f9280]"><summary className="cursor-pointer">Result</summary><pre className="mt-2 whitespace-pre-wrap break-words max-h-64 overflow-y-auto rounded-xl bg-black p-3 text-[10px] select-text">{JSON.stringify(result, null, 2)}</pre></details>}
  </div>;
}

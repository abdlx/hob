import { useCallback, useEffect, useRef, useState } from 'react';
import { useChat } from '../context/ChatContext';
import { useRuntime } from '../context/RuntimeContext';
import { apiFetch } from '../services/api';
import { hermesModelSelectionResult } from '../services/hermes-settings';
import { HermesModelPicker } from './HermesModelPicker';
import { buttonClass, Field, inputClass, Notice } from './WorkspaceUI';
import { errorText } from './workspaceUtils';

export function AgentModelSettings() {
  const { agent } = useChat();
  const runtime = useRuntime();
  if (!agent) return <Notice>Select a bot to configure its model.</Notice>;
  return runtime === 'hermes' ? <HermesAgentModel key={agent.id} profile={agent.id} /> : <OpenClawAgentModel key={agent.id} />;
}

function HermesAgentModel({ profile }: { profile: string }) {
  const { refresh, createNewSession } = useChat();
  const [provider, setProvider] = useState(''), [model, setModel] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState(''), [saved, setSaved] = useState(false);
  const [revision, setRevision] = useState(0);
  const initialized = useRef(false), pending = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const initialize = useCallback((catalog: { provider?: string; model?: string }) => {
    if (initialized.current) return;
    initialized.current = true;
    setProvider(catalog.provider || ''); setModel(catalog.model || '');
  }, []);
  async function save(confirmExpensive = false) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setSaved(false);
    try {
      const result = hermesModelSelectionResult(await apiFetch(`/api/hermes/model?profile=${encodeURIComponent(profile)}`, {
        method: 'POST', headers: { 'X-Hob-Profile': profile },
        body: JSON.stringify({ scope: 'main', provider: provider.trim(), model: model.trim(), ...(confirmExpensive ? { confirm_expensive_model: true } : {}) }),
      }));
      if (!alive.current) return;
      if (!result.saved) { setConfirmation(result.confirmation); return; }
      setConfirmation(''); setSaved(true); setRevision(value => value + 1);
      await refresh();
    } catch (cause) { if (alive.current) setError(errorText(cause)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  return <section aria-label="Bot model" className="space-y-3">
    <h3 className="text-sm font-semibold text-ink">Model</h3>
    <p className="text-xs leading-relaxed text-muted">Choose this bot's model for new conversations. Connect providers and add custom endpoints in Settings.</p>
    {error && <Notice error>{error}</Notice>}
    <HermesModelPicker key={revision} profile={profile} provider={provider} model={model} busy={busy} onLoaded={initialize}
      chooseProvider={value => { initialized.current = true; setProvider(value); setModel(''); setConfirmation(''); setSaved(false); }}
      chooseModel={value => { initialized.current = true; setModel(value); setConfirmation(''); setSaved(false); }} />
    <button className={buttonClass} disabled={busy || !provider.trim() || !model.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save model'}</button>
    {confirmation && <div className="space-y-2"><Notice>{confirmation}</Notice><button className={buttonClass} disabled={busy} onClick={() => void save(true)}>Confirm this model selection</button></div>}
    {saved && <Notice>Model saved. <button className="underline text-accent" disabled={busy} onClick={() => void createNewSession()}>Start a new conversation</button> to use it.</Notice>}
  </section>;
}

function OpenClawAgentModel() {
  const { agent, updateAgent } = useChat();
  const [model, setModel] = useState(agent?.model || ''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <section aria-label="Bot model" className="space-y-3"><h3 className="text-sm font-semibold text-ink">Model</h3>
    {error && <Notice error>{error}</Notice>}
    <Field label="Model"><input className={inputClass} value={model} disabled={busy} onChange={event => setModel(event.target.value)} /></Field>
    <button className={buttonClass} disabled={busy || !model.trim() || model.trim() === agent?.model} onClick={async () => {
      setBusy(true); setError('');
      try { await updateAgent({ model: model.trim() }); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
    }}>{busy ? 'Saving…' : 'Save model'}</button>
  </section>;
}

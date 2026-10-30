import { useState } from 'react';
import { apiFetch } from '../services/api';
import { buttonClass, Field, inputClass, Notice } from './WorkspaceUI';
import { errorText } from './workspaceUtils';

interface ModelRoute { id: string; profile: string; endpoint: string; models: string[]; billingMode: 'free' | 'local' | 'subscription'; credentialDigest: string; basis: string }
interface Receipt extends ModelRoute { digest: string; approvedAt: number; revoked: number | null }
interface RouteState { revision: number; routes: Receipt[] }
interface Preview { revision: number; digest: string; route: ModelRoute }

export function HermesTeamExecutionSettings({ bots }: { bots: { id: string; name: string }[] }) {
  const [opened, setOpened] = useState(false), [state, setState] = useState<RouteState | null>(null);
  const [profile, setProfile] = useState(bots[0]?.id || ''), [endpoint, setEndpoint] = useState(''), [models, setModels] = useState('');
  const [billingMode, setBillingMode] = useState<ModelRoute['billingMode']>('subscription'), [credentialDigest, setCredentialDigest] = useState(''), [basis, setBasis] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null), [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const clearPreview = () => { setPreview(null); setReviewed(false); };
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { await work(); } catch (value) { setError(errorText(value)); } finally { setBusy(false); }
  };
  const read = async () => { setState(await apiFetch<RouteState>('/api/hermes/team/execution/routes')); clearPreview(); };
  const post = <T,>(path: string, body: unknown) => apiFetch<T>(`/api/hermes/team/execution/routes${path}`, { method: 'POST', body: JSON.stringify(body) });
  return <section className="min-w-0 space-y-3 rounded-xl border border-hair p-3" aria-label="Team model execution routes">
    <h3 className="text-sm font-medium">Model routes with no usage charges</h3>
    <p className="text-xs text-muted">Existing subscriptions are allowed when requests and overages have no extra charges. Team execution remains inactive pending native qualification.</p>
    <button className={buttonClass} disabled={busy} aria-expanded={opened} onClick={() => { if (!opened) void run(read); setOpened(!opened); }}>{opened ? 'Close model route review' : 'Review model routes'}</button>
    {opened && <div className="min-w-0 space-y-3">
      {error && <Notice error>{error}</Notice>}{message && <Notice>{message}</Notice>}
      <Notice>Approve only an existing endpoint/account whose billing terms you checked. The native guard reports a credential fingerprint when it refuses an unapproved request. A changed credential needs a new review. Provider-side paid plugins and server tools remain unavailable.</Notice>
      <button className={buttonClass} disabled={busy} onClick={() => void run(read)}>Refresh model routes</button>
      {state && <>
        <fieldset disabled={busy} className="min-w-0 space-y-3" onChange={clearPreview}>
          <Field label="Route bot"><select className={inputClass} value={profile} onChange={event => setProfile(event.target.value)}>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></Field>
          <Field label="Inference endpoint" hint="Complete URL ending in /chat/completions, /responses or /messages."><input className={inputClass} value={endpoint} onChange={event => setEndpoint(event.target.value)} /></Field>
          <Field label="Exact model IDs" hint="One wire model ID per line. Each fallback must be approved too."><textarea className={inputClass} rows={3} value={models} onChange={event => setModels(event.target.value)} /></Field>
          <Field label="Billing contract"><select className={inputClass} value={billingMode} onChange={event => setBillingMode(event.target.value as ModelRoute['billingMode'])}><option value="subscription">Existing subscription, no usage charges</option><option value="free">Free model route</option><option value="local">Local model, no usage charges</option></select></Field>
          <Field label="Credential fingerprint" hint="64-character SHA-256 reported by the guard. Keep the actual token in its credential store."><input className={inputClass} value={credentialDigest} onChange={event => setCredentialDigest(event.target.value)} /></Field>
          <Field label="Billing review evidence" hint="Record the source and date of your check, including overage settings. Exclude secrets."><textarea className={inputClass} rows={3} value={basis} onChange={event => setBasis(event.target.value)} /></Field>
          <button className={buttonClass} onClick={() => void run(async () => {
            setPreview(await post<Preview>('/preview', { profile, endpoint, models: models.split('\n').map(value => value.trim()).filter(Boolean), billingMode, credentialDigest, basis })); setReviewed(false);
          })}>Prepare exact route review</button>
        </fieldset>
        {preview && <div className="min-w-0 space-y-3 rounded-xl bg-panel p-3" aria-label="Exact model route review">
          <p className="break-words text-xs">Bot: {bots.find(bot => bot.id === preview.route.profile)?.name || preview.route.profile}</p>
          <p className="break-all text-xs">Endpoint: {preview.route.endpoint}</p>
          <p className="break-words text-xs">Models: {preview.route.models.join(', ')}</p>
          <p className="text-xs">Billing: {preview.route.billingMode}</p>
          <p className="break-all text-xs">Credential: {preview.route.credentialDigest}</p>
          <p className="whitespace-pre-wrap break-words text-xs">Evidence: {preview.route.basis}</p>
          <label className="flex items-start gap-2 text-xs"><input type="checkbox" disabled={busy} checked={reviewed} onChange={event => setReviewed(event.target.checked)} /><span>I verified that this exact endpoint, model list and credential have no usage or overage charges.</span></label>
          <button className={buttonClass} disabled={busy || !reviewed} onClick={() => void run(async () => {
            setState(await post<RouteState>('', { ...preview, confirm: true, confirmNoUsageCharges: true })); clearPreview(); setMessage('Route approval saved. Team execution remains inactive pending native qualification.');
          })}>Approve reviewed model route</button>
        </div>}
        <div className="min-w-0 space-y-2" aria-label="Model route approvals">
          {state.routes.length === 0 && <p className="text-xs text-muted">No model routes approved. Guarded team requests are refused until a route is reviewed.</p>}
          {state.routes.map(route => <div className="min-w-0 space-y-2 rounded-xl border border-hair p-3 text-xs" key={route.id}>
            <p>{bots.find(bot => bot.id === route.profile)?.name || route.profile} · {route.billingMode} · {route.revoked === null ? 'approved' : 'revoked'}</p>
            <p className="break-all">{route.endpoint}</p><p className="break-words">{route.models.join(', ')}</p>
            <p className="break-all">Credential: {route.credentialDigest}</p><p className="break-words">{route.basis}</p>
            {route.revoked === null && <button className={buttonClass} disabled={busy} onClick={() => void run(async () => {
              setState(await post<RouteState>('/revoke', { id: route.id, digest: route.digest, revision: state.revision, confirm: true })); clearPreview(); setMessage('Approval revoked. Each future request requires an active approval.');
            })}>Revoke this model route</button>}
          </div>)}
        </div>
      </>}
    </div>}
  </section>;
}

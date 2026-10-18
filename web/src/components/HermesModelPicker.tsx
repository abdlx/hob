import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../services/api';
import { buttonClass, Field, inputClass, Notice } from './WorkspaceUI';
import { errorText } from './workspaceUtils';

interface Provider { slug: string; name: string; models: (string | { id: string; name?: string })[]; authenticated?: boolean; key_env?: string; warning?: string }
interface Catalog { providers: Provider[]; provider?: string; model?: string }

export function HermesModelPicker({ profile, provider, model, busy, chooseProvider, chooseModel }: {
  profile: string; provider: string; model: string; busy: boolean;
  chooseProvider: (provider: string, keyEnv?: string) => void; chooseModel: (model: string) => void;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const invalidate = useCallback(() => { sequence.current++; }, []);
  const load = useCallback(async (refresh = false) => {
    const current = ++sequence.current; setLoading(true);
    try {
      const result = await apiFetch<Catalog>(`/api/hermes/setup/models?profile=${encodeURIComponent(profile)}${refresh ? '&refresh=true' : ''}`, { headers: { 'X-Hob-Profile': profile } });
      if (!Array.isArray(result.providers)) throw new Error('Hermes returned an invalid model catalog.');
      if (sequence.current === current) { setCatalog(result); setError(''); }
    } catch (error) { if (sequence.current === current) setError(errorText(error)); }
    finally { if (sequence.current === current) setLoading(false); }
  }, [profile]);
  useEffect(() => { const timer = window.setTimeout(() => load(), 0); return () => { invalidate(); window.clearTimeout(timer); }; }, [load, invalidate]);
  const selected = catalog?.providers.find(item => item.slug === provider);
  const models = selected?.models || [];
  return <div className="space-y-3">{error && <Notice error>{error}</Notice>}{catalog?.provider && <p className="text-xs text-muted">Saved selection: {catalog.provider} / {catalog.model || 'no model'}</p>}
    <Field label="Provider" hint="Native Hermes providers and saved endpoints. Selecting here fills the form; it does not activate a model."><select className={inputClass} value={provider} disabled={busy || loading} onChange={event => chooseProvider(event.target.value, catalog?.providers.find(item => item.slug === event.target.value)?.key_env)}><option value="">Choose a provider</option>{catalog?.providers.map(item => <option key={item.slug} value={item.slug}>{item.name}{item.authenticated === false ? ' · sign-in/key needed' : ''}</option>)}{!catalog?.providers.some(item => item.slug === 'custom') && <option value="custom">Custom compatible endpoint</option>}{provider && !catalog?.providers.some(item => item.slug === provider) && provider !== 'custom' && <option value={provider}>{provider}</option>}</select></Field>
    {selected?.warning && <Notice>{selected.warning}</Notice>}
    <Field label="Model" hint={models.length ? 'Choose a native catalog suggestion or enter another model supported by your account.' : 'Save the provider credential or complete sign-in, then refresh the catalog. You can also enter a model identifier.'}><input className={inputClass} value={model} list={`hermes-model-options-${profile}`} placeholder="Choose or enter a model" disabled={busy} onChange={event => chooseModel(event.target.value)} /><datalist id={`hermes-model-options-${profile}`}>{models.map(item => { const id = typeof item === 'string' ? item : item.id; return <option key={id} value={id}>{typeof item === 'string' ? item : item.name || id}</option>; })}</datalist></Field>
    <button className={buttonClass} disabled={busy || loading} onClick={() => load(true)}>{loading ? 'Loading catalog…' : 'Refresh model catalog'}</button>
  </div>;
}

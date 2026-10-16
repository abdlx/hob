import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { Brand } from './Brand';
import { apiFetch } from '../services/api';

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ authenticated: boolean; configured: boolean } | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const check = useCallback(async () => {
    try { setState(await apiFetch('/api/auth/status')); setError(''); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not connect to hob.'); }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(check);
    const expired = () => { setState(previous => previous ? { ...previous, authenticated: false } : null); setError('Your session expired. Sign in again.'); };
    window.addEventListener('muse:unauthorized', expired);
    return () => window.removeEventListener('muse:unauthorized', expired);
  }, [check]);
  const login = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await apiFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }); setPassword(''); await check(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not sign in.'); }
    finally { setBusy(false); }
  };
  if (state?.authenticated) return children;
  return <div className="hob-auth h-full w-full flex items-center justify-center px-6">
    <div className="hob-auth-card w-full max-w-sm rounded-3xl border p-8 space-y-6">
      <Brand />
      <div><h1 className="text-3xl font-semibold text-[#f6eee6] tracking-tight">A little more life.</h1><p className="mt-2 text-xs leading-relaxed text-[#8a8883]">Your helpful household spirit. Powered by OpenClaw, on your server.</p></div>
      {!state && !error && <p className="text-xs text-[#8a8883]" role="status">Connecting…</p>}
      {state?.configured && <form onSubmit={login} className="space-y-3">
        <label className="block text-xs text-[#dedcd8]" htmlFor="password">Server password</label>
        <input id="password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} className="w-full bg-black border border-[#303030] rounded-xl p-3 text-sm focus:outline-none focus:border-[#936f4d]" />
        <button disabled={busy} className="w-full rounded-full bg-[#936f4d] text-white py-2.5 text-xs disabled:opacity-50">{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>}
      {state && !state.configured && <p className="text-xs leading-relaxed text-[#b6a592]">Set MUSE_PASSWORD on your server and restart hob to finish securing this installation.</p>}
      {error && <p role="alert" className="text-xs leading-relaxed text-red-300">{error}</p>}
      {!state && error && <button onClick={() => void check()} className="flex items-center gap-2 text-xs text-[#dedcd8]"><RefreshCw size={13} />Retry connection</button>}
    </div>
  </div>;
}

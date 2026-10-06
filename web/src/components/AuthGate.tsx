import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { LockKeyhole, RefreshCw } from 'lucide-react';
import { apiFetch } from '../services/api';

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ authenticated: boolean; configured: boolean } | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const check = useCallback(async () => {
    try { setState(await apiFetch('/api/auth/status')); setError(''); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not connect to OpenMuse.'); }
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
  return <div className="h-full w-full bg-black flex items-center justify-center px-6">
    <div className="w-full max-w-sm rounded-3xl border border-[#262626] bg-[#101010] p-7 space-y-5">
      <div className="w-11 h-11 rounded-full bg-[#25201b] flex items-center justify-center text-[#bd936c]"><LockKeyhole size={20} /></div>
      <div><h1 className="text-xl font-semibold text-white">OpenMuse</h1><p className="mt-2 text-xs leading-relaxed text-[#8a8883]">Your agent, on your server.</p></div>
      {!state && !error && <p className="text-xs text-[#8a8883]" role="status">Connecting…</p>}
      {state?.configured && <form onSubmit={login} className="space-y-3">
        <label className="block text-xs text-[#dedcd8]" htmlFor="password">Server password</label>
        <input id="password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} className="w-full bg-black border border-[#303030] rounded-xl p-3 text-sm focus:outline-none focus:border-[#936f4d]" />
        <button disabled={busy} className="w-full rounded-full bg-[#936f4d] text-white py-2.5 text-xs disabled:opacity-50">{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>}
      {state && !state.configured && <p className="text-xs leading-relaxed text-[#b6a592]">Set MUSE_PASSWORD on your server and restart OpenMuse to finish securing this installation.</p>}
      {error && <p role="alert" className="text-xs leading-relaxed text-red-300">{error}</p>}
      {!state && error && <button onClick={() => void check()} className="flex items-center gap-2 text-xs text-[#dedcd8]"><RefreshCw size={13} />Retry connection</button>}
    </div>
  </div>;
}

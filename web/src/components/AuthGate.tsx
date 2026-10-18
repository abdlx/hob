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
    try {
      setState(await apiFetch('/api/auth/status'));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect to hob.');
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(check);
    const expired = () => {
      setState((previous) => (previous ? { ...previous, authenticated: false } : null));
      setError('Your session expired. Sign in again.');
    };
    window.addEventListener('muse:unauthorized', expired);
    return () => window.removeEventListener('muse:unauthorized', expired);
  }, [check]);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      setPassword('');
      await check();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };

  const isPreview = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('preview') === '1';

  if (state?.authenticated || isPreview) return children;

  return (
    <div className="hob-auth h-full w-full flex items-center justify-center px-6 bg-app">
      <div className="hob-auth-card w-full max-w-sm rounded-[32px] bg-surface border border-hair shadow-[0_12px_40px_rgba(0,0,0,0.055)] p-8 space-y-6">
        <Brand />
        <div>
          <h1 className="text-2xl font-semibold text-ink tracking-tight">A little more life.</h1>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            Your helpful household spirit. Powered by Hermes, on your server.
          </p>
        </div>
        {!state && !error && <p className="text-xs text-faint" role="status">Connecting…</p>}
        {state?.configured && (
          <form onSubmit={login} className="space-y-3.5">
            <label className="block text-xs font-medium text-ink" htmlFor="password">
              Server password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full bg-panel border border-edge rounded-xl p-3 text-sm text-ink focus:outline-none focus:border-accent"
            />
            <button
              disabled={busy}
              className="w-full rounded-full bg-accent hover:bg-accent-strong text-white py-2.5 text-xs font-semibold disabled:opacity-50 transition-colors shadow-xs cursor-pointer"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
        {state && !state.configured && (
          <p className="text-xs leading-relaxed text-muted">
            Set MUSE_PASSWORD on your server and restart hob to finish securing this installation.
          </p>
        )}
        {error && <p role="alert" className="text-xs leading-relaxed text-red-600">{error}</p>}
        {!state && error && (
          <button
            onClick={() => void check()}
            className="flex items-center gap-2 text-xs text-accent hover:underline cursor-pointer"
          >
            <RefreshCw size={13} />
            Retry connection
          </button>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { apiFetch } from '../services/api';
import type { BotExchange } from '../components/BotExchanges';
interface ExchangePage { exchanges: BotExchange[]; earlier?: boolean }
const failure = (error: unknown) => error instanceof Error ? error.message : 'Could not load bot exchanges.';
const endpoint = (profile: string, path: string) => `/api/hermes/exchanges${path}&profile=${encodeURIComponent(profile)}`;

export function useBotExchanges(profile: string | undefined, session: string | null, enabled: boolean) {
  const [state, setState] = useState<{ key: string; rows: BotExchange[]; error: string; earlier: boolean }>({ key: '', rows: [], error: '', earlier: false });
  const key = `${profile}:${session}`;
  useEffect(() => {
    if (!enabled || !profile || !session) return;
    let stopped = false, pending = false;
    const load = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const result = await apiFetch<ExchangePage>(endpoint(profile, `?session=${encodeURIComponent(session)}`));
        if (!stopped) setState({ key, rows: result.exchanges, error: '', earlier: result.earlier === true });
      } catch (error) { if (!stopped) setState(previous => ({ key, rows: previous.key === key ? previous.rows : [], error: failure(error), earlier: previous.key === key && previous.earlier })); }
      finally { pending = false; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 10000);
    const visible = () => { if (!document.hidden) void load(); };
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ from: string; to: string }>).detail;
      if (detail && [detail.from, detail.to].includes(profile)) void load();
    };
    window.addEventListener('hob:bot-exchange', changed);
    document.addEventListener('visibilitychange', visible);
    return () => { stopped = true; window.removeEventListener('hob:bot-exchange', changed); clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [profile, session, enabled, key]);
  return enabled && state.key === key ? state : { key, rows: [], error: '', earlier: false };
}

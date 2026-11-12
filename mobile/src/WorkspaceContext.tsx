import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { Connection } from './connection';
import type { Bot } from './workspace-types';
import { workspaceApi } from './workspace-api';
import { messageOf } from './ui';

interface Workspace { connection: Connection; bots: Bot[]; refreshBots: () => Promise<void>; error: string }
const Context = createContext<Workspace | null>(null);
export function WorkspaceProvider({ connection, children }: { connection: Connection; children: React.ReactNode }) {
  const [bots, setBots] = useState<Bot[]>([]), [error, setError] = useState('');
  const api = useMemo(() => workspaceApi(connection, 'default'), [connection]);
  const refreshBots = useCallback(async () => {
    try {
      const result = await api.request<{ agents: Bot[] }>('/api/agents');
      const origin = connection.origin.replace(/\/+$/, '');
      const normalized = (result.agents || []).map(b => {
        let avatarUrl = b.avatarUrl?.trim();
        if (avatarUrl && !/^https?:\/\//i.test(avatarUrl) && !avatarUrl.startsWith('data:')) {
          avatarUrl = `${origin}/${avatarUrl.replace(/^\/+/, '')}`;
        }
        return { ...b, avatarUrl };
      });
      setBots(normalized);
      setError('');
    }
    catch (error) { setError(messageOf(error)); }
  }, [api, connection.origin]);
  useEffect(() => { void refreshBots(); }, [refreshBots]);
  return <Context.Provider value={{ connection, bots, refreshBots, error }}>{children}</Context.Provider>;
}
export function useWorkspace() { const value = useContext(Context); if (!value) throw new Error('Workspace unavailable.'); return value; }
export function useBotApi(profile: string) { const { connection } = useWorkspace(); return useMemo(() => workspaceApi(connection, profile), [connection, profile]); }

/** Loads only while visible, discards stale reads, and refreshes after foregrounding. */
export function useResource<T>(load: (signal: AbortSignal) => Promise<T>, pollMs = 0) {
  const [state, setState] = useState<{ owner: typeof load; data: T | null; error: string; loading: boolean }>({ owner: load, data: null, error: '', loading: true });
  const sequence = useRef(0), controller = useRef<AbortController | null>(null), focused = useRef(false);
  const refresh = useCallback(async () => {
    controller.current?.abort(); const active = new AbortController(); controller.current = active;
    const current = ++sequence.current;
    setState(previous => ({ owner: load, data: previous.owner === load ? previous.data : null, error: '', loading: previous.owner !== load || previous.data === null }));
    try { const result = await load(active.signal); if (current === sequence.current) setState({ owner: load, data: result, error: '', loading: false }); return result; }
    catch (error) { if (!active.signal.aborted && current === sequence.current) setState(previous => ({ ...previous, error: messageOf(error), loading: false })); }
    finally { if (controller.current === active) controller.current = null; }
  }, [load]);
  useFocusEffect(useCallback(() => {
    focused.current = true; void refresh();
    const listener = AppState.addEventListener('change', state => { if (state === 'active') void refresh(); else controller.current?.abort(); });
    const timer = pollMs ? setInterval(() => { if (AppState.currentState === 'active' && !controller.current) void refresh(); }, pollMs) : undefined;
    return () => { focused.current = false; sequence.current++; controller.current?.abort(); listener.remove(); if (timer) clearInterval(timer); };
  }, [refresh, pollMs]));
  return { data: state.owner === load ? state.data : null, error: state.owner === load ? state.error : '', loading: state.owner !== load || state.loading, refresh, focused };
}

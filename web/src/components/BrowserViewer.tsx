import { useCallback, useEffect, useRef, useState } from 'react';
import { RemoteBrowser, type RemoteBrowserHandle } from '@atriumjs/react';
import { apiFetch } from '../services/api';
import { buttonClass, inputClass, Notice, StatusPill } from './WorkspaceUI';
import { errorText } from './workspaceUtils';

// Live viewer for a bot's persistent, HOB-managed browser.
//
// The page is rendered by `@atriumjs/react` over the Atrium protocol. Everything
// around it — starting the browser, who holds control, what the agent is doing —
// is HOB's own surface, because those are exactly the things HOB enforces and the
// viewer must not be able to disagree with the gateway about.

interface BrowserTab { id: string; url: string; title: string; active: boolean }

interface BrowserStatus {
  bot: string;
  state: 'starting' | 'running' | 'stopped';
  control: { holder: 'agent' | 'human' | 'idle'; since: number | null; pending: number };
  viewers: number;
  agentConnections: number;
  viewport: { w: number; h: number };
  tabs: BrowserTab[];
  url: string;
  title: string;
  loading: boolean;
  lastError: string | null;
  available: boolean;
  browserExecutable: string | null;
}

interface ViewerCredentials { sessionId: string; viewerToken: string; wsUrl: string }

interface Activity { id: number; at: number; text: string }
interface Cursor { x: number; y: number; kind: 'move' | 'click' }

const POLL_MS = 3000;
const ACTIVITY_LIMIT = 6;

const query = (profile: string) => `?profile=${encodeURIComponent(profile)}`;

/** Turn a raw agent command into something a person can read. */
function describe(payload: Record<string, unknown>): string | null {
  const type = String(payload.type ?? '');
  if (type === 'action') {
    const kind = String(payload.kind ?? 'command');
    const method = String(payload.method ?? '');
    if (kind === 'dialog') return 'Page opened a dialog';
    if (kind === 'type') return 'Typing text';
    if (kind === 'key') return 'Pressing keys';
    return method ? `Running ${method}` : 'Driving the browser';
  }
  if (type === 'browser' && payload.state === 'crashed') return 'The browser crashed';
  if (type === 'agent') return payload.state === 'connected' ? 'The bot connected' : 'The bot disconnected';
  if (type === 'viewer') return `A viewer ${payload.state === 'left' ? 'left' : 'joined'}`;
  return null;
}

export function BrowserViewer({ profile }: { profile: string }) {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [credentials, setCredentials] = useState<ViewerCredentials | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [terminated, setTerminated] = useState('');
  const viewer = useRef<RemoteBrowserHandle>(null);
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    const ticket = ++sequence.current;
    try {
      const next = await apiFetch<BrowserStatus>(`/api/hermes/browser${query(profile)}`);
      if (ticket === sequence.current) { setStatus(next); setError(''); }
    } catch (problem) {
      if (ticket === sequence.current) setError(errorText(problem));
    }
  }, [profile]);

  // The parent remounts this panel per bot (`key={agent.id}`), so there is no
  // profile-change state to reset here; polling is all this needs.
  useEffect(() => {
    let stopped = false;
    const load = () => { if (!stopped) void refresh(); };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [refresh]);

  // Agent activity arrives over SSE rather than the viewer socket: the viewer
  // socket is the Atrium protocol, which parses strictly and would treat an extra
  // message type as an error.
  useEffect(() => {
    const events = new EventSource(`/api/hermes/browser/activity${query(profile)}`);
    let counter = 0;
    events.addEventListener('browser', message => {
      let payload: Record<string, unknown>;
      try { payload = JSON.parse((message as MessageEvent).data); } catch { return; }
      if (payload.type === 'cursor' && typeof payload.x === 'number' && typeof payload.y === 'number') {
        setCursor({ x: payload.x, y: payload.y, kind: 'move' });
        return;
      }
      if (payload.type === 'click' && typeof payload.x === 'number' && typeof payload.y === 'number') {
        setCursor({ x: payload.x, y: payload.y, kind: 'click' });
        const entry = { id: ++counter, at: Date.now(), text: `Clicked ${String(payload.button ?? 'left')}` };
        setActivity(previous => [entry, ...previous].slice(0, ACTIVITY_LIMIT));
        return;
      }
      const text = describe(payload);
      if (!text) return;
      setActivity(previous => [{ id: ++counter, at: Date.now(), text }, ...previous].slice(0, ACTIVITY_LIMIT));
    });
    return () => events.close();
  }, [profile]);

  const act = useCallback(async (label: string, path: string, init: RequestInit = {}) => {
    setBusy(label);
    try {
      await apiFetch(`/api/hermes/browser${path}${query(profile)}`, { method: 'POST', ...init });
      await refresh();
    } catch (problem) { setError(errorText(problem)); } finally { setBusy(''); }
  }, [profile, refresh]);

  const openViewer = async () => {
    setBusy('open'); setTerminated('');
    try {
      if (status?.state !== 'running') await apiFetch(`/api/hermes/browser/start${query(profile)}`, { method: 'POST' });
      const minted = await apiFetch<{ sessionId: string; viewerToken: string; wsPath: string }>(`/api/hermes/browser/viewer${query(profile)}`, { method: 'POST' });
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      setCredentials({ sessionId: minted.sessionId, viewerToken: minted.viewerToken, wsUrl: `${scheme}//${window.location.host}${minted.wsPath}` });
      await refresh();
    } catch (problem) { setError(errorText(problem)); } finally { setBusy(''); }
  };

  const closeViewer = () => { setCredentials(null); setCursor(null); };
  const holder = status?.control.holder ?? 'agent';
  const interactive = credentials !== null && holder === 'human';

  const onError = useCallback((problem: unknown) => {
    // The viewer gives up reconnecting eventually; say so instead of leaving a
    // frozen canvas that looks like the browser is merely quiet.
    if (problem instanceof Error && problem.message === 'reconnect_exhausted' && credentials) {
      setCredentials(null);
      setCursor(null);
      setTerminated('The live view lost its connection to the server. Reopen it to continue watching.');
    }
  }, [credentials]);

  if (error && !status) return <Notice error>{error}</Notice>;
  if (!status) return <p className="text-xs md:text-sm text-muted">Checking this bot’s browser…</p>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={status.state === 'running' ? 'active' : status.state === 'starting' ? 'pending' : 'idle'} label={status.state} />
        <span className="text-xs text-muted">
          {status.viewers > 0 ? `${status.viewers} watching` : 'nobody watching'} · {holder === 'human' ? 'you have control' : 'the bot has control'}
        </span>
      </div>

      {!status.available && <Notice error>No Chromium-family browser was found on the host, so this bot has no browser to show. Install Chromium, or set HOB_CHROMIUM_PATH.</Notice>}
      {error && <Notice error>{error}</Notice>}
      {status.lastError && <Notice error>{status.lastError}</Notice>}
      {terminated && <Notice>{terminated}</Notice>}

      {!credentials && (
        <div className="space-y-3">
          <Notice>{status.state === 'running'
            ? 'This browser is already running. Open the live view to watch the bot and step in when you need to.'
            : 'Opening the live view starts this bot’s browser. It keeps a single profile, so its logins and open pages carry over between visits.'}</Notice>
          <button className={buttonClass} disabled={busy !== '' || !status.available} onClick={() => void openViewer()}>
            {status.state === 'running' ? 'Open live view' : 'Start and watch'}
          </button>
        </div>
      )}

      {credentials && (
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <button className={buttonClass} disabled={holder !== 'agent' || busy !== ''} onClick={() => void act('take', '/control', { body: JSON.stringify({ action: 'take' }) })}>Take control</button>
            <button className={buttonClass} disabled={holder !== 'human' || busy !== ''} onClick={() => void act('release', '/control', { body: JSON.stringify({ action: 'release' }) })}>Return control</button>
            <button className={buttonClass} disabled={busy !== ''} onClick={() => viewer.current?.back()}>Back</button>
            <button className={buttonClass} disabled={busy !== ''} onClick={() => viewer.current?.forward()}>Forward</button>
            <button className={buttonClass} disabled={busy !== ''} onClick={() => viewer.current?.reload()}>Reload</button>
            <button className={buttonClass} disabled={busy !== ''} onClick={() => void act('stop', '/stop').then(closeViewer)}>Stop browser</button>
            <button className={buttonClass} onClick={closeViewer}>Hide view</button>
          </div>
          <input className={inputClass} readOnly value={status.url || 'about:blank'} aria-label="Current page" />

          <div className="relative overflow-hidden rounded-xl border border-hair bg-sunken" style={{ minHeight: 280 }}>
            <RemoteBrowser
              ref={viewer}
              sessionId={credentials.sessionId}
              viewerToken={credentials.viewerToken}
              wsUrl={credentials.wsUrl}
              chrome="none"
              showSessionStatus={false}
              interactive={interactive}
              onControlChange={value => { setStatus(current => current ? { ...current, control: { ...current.control, holder: value } } : current); }}
              onTerminated={reason => {
                setCredentials(null);
                setCursor(null);
                setTerminated(reason === 'idle'
                  ? 'The browser was idle, so it was shut down. Its profile — logins and open pages — is kept; reopen the live view to start it again.'
                  : `The live view ended (${reason}).`);
                void refresh();
              }}
              onError={onError}
              style={{ width: '100%', minHeight: 280 }}
            />
            {/* The agent's own pointer, harvested from the mouse commands it sends.
                Positioned as a fraction of the browser viewport, which is what the
                canvas is showing at any scale. */}
            {cursor && status.viewport.w > 0 && status.viewport.h > 0 && (
              <span
                aria-hidden
                className={`pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-full ${cursor.kind === 'click' ? 'h-4 w-4 bg-accent/60' : 'h-2.5 w-2.5 bg-accent'}`}
                style={{ left: `${(cursor.x / status.viewport.w) * 100}%`, top: `${(cursor.y / status.viewport.h) * 100}%` }}
              />
            )}
          </div>

          {!interactive && <p className="text-xs text-muted">The bot is driving. Take control to click and type yourself; the bot’s changes are held until you hand it back.</p>}
          {interactive && <p className="text-xs text-muted">You are driving. The bot cannot change this page until you return control.</p>}

          {activity.length > 0 && (
            <ul className="space-y-1">
              {activity.map(entry => (
                <li key={entry.id} className="text-xs text-muted">
                  <span className="text-faint">{new Date(entry.at).toLocaleTimeString()} · </span>{entry.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

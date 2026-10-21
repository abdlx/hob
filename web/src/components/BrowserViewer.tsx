import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { RemoteBrowser, type RemoteBrowserHandle } from '@atriumjs/react';
import { ArrowLeft, ArrowRight, EyeOff, Globe2, Loader2, Lock, Maximize2, Minimize2, MousePointer2, RotateCw, ShieldCheck, Square } from 'lucide-react';
import { apiFetch } from '../services/api';
import { buttonClass, Notice, StatusPill } from './WorkspaceUI';
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
  transport?: 'pipe' | 'tcp';
}

interface BindingReport {
  profile?: string;
  configured: boolean;
  backend: string | null;
  configuredPort: number | null;
  expectedPort: number | null;
  envOverride: boolean;
  reason: 'bound' | 'missing' | 'backend' | 'stale-url' | 'unreadable' | 'unavailable';
  error?: string;
}

interface BindingRepair { ok: boolean; changed: boolean; error?: string }

interface Diagnosis extends BrowserStatus {
  binding: BindingReport | null;
  repair?: BindingRepair;
}

interface ViewerCredentials { sessionId: string; viewerToken: string; wsUrl: string }

interface Activity { id: number; at: number; text: string }
interface Cursor { x: number; y: number; kind: 'move' | 'click' }

const POLL_MS = 2000;
const ACTIVITY_LIMIT = 6;
const CONNECT_HINT_MS = 8000;

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

function bindingMessage(report: BindingReport): string {
  if (report.envOverride) return 'BROWSER_CDP_URL is set in the server environment, so it overrides this bot’s profile binding.';
  if (report.error) return `HOB could not read this bot’s browser settings: ${report.error}`;
  if (report.reason === 'missing') return 'This bot has no managed-browser binding yet.';
  if (report.reason === 'backend') return 'This bot is configured for a different browser backend, so the managed browser is ignored.';
  if (report.reason === 'stale-url') return 'This bot points at a different or stale browser endpoint.';
  if (report.reason === 'unavailable') return 'The managed browser is not available on this server.';
  return 'This bot is not pointed at its managed browser.';
}

function bindingLine(report: BindingReport): string {
  if (report.configured && !report.envOverride) {
    return `This bot is bound to its managed browser${report.expectedPort ? ` (port ${report.expectedPort})` : ''}.`;
  }
  const ports = report.expectedPort
    ? ` Expected port ${report.expectedPort}${report.configuredPort ? `, configured port ${report.configuredPort}` : ''}.`
    : '';
  return `${bindingMessage(report)}${ports}`;
}

function hostLabel(url: string): string {
  if (!url || url === 'about:blank') return 'New tab';
  try { return new URL(url).hostname.replace(/^www\./, '') || url; } catch { return url; }
}

function NavButton({ label, onClick, disabled, children }: {
  label: string; onClick: () => void; disabled?: boolean; children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-soft transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
    >
      {children}
    </button>
  );
}

// The page Chromium starts on is `about:blank`; showing that as a bare white
// rectangle is indistinguishable from a broken stream. A new-tab surface keeps
// the browser frame honest while the bot has not opened anything yet.
function BrowserStartPage({ live }: { live: boolean }) {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 px-6 text-center"
      style={{ background: 'radial-gradient(ellipse at top, #EEF4FF 0%, #F8FAFC 55%, #F1F5F9 100%)' }}
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-accent-line bg-surface/80 shadow-sm">
        <Globe2 size={26} className="text-accent" />
      </div>
      <div className="space-y-1.5">
        <p className="text-sm font-semibold text-ink">The bot’s browser is ready</p>
        <p className="mx-auto max-w-sm text-xs leading-relaxed text-muted">
          Send a message that uses the browser. Its page will appear here, and you can take over at any time.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2 text-[11px] text-soft">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-hair bg-surface/80 px-2.5 py-1">
          <MousePointer2 size={12} /> Take control any time
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-hair bg-surface/80 px-2.5 py-1">
          <ShieldCheck size={12} /> Sandboxed
        </span>
      </div>
      <p className="inline-flex items-center gap-1.5 text-[11px] text-faint">
        {live ? 'Waiting for the bot to open a page.' : <><Loader2 size={11} className="animate-spin" /> Connecting to the live view…</>}
      </p>
    </div>
  );
}

export function BrowserViewer({ profile }: { profile: string }) {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [checking, setChecking] = useState(false);
  const [binding, setBinding] = useState<BindingReport | null>(null);
  const [repair, setRepair] = useState<BindingRepair | null>(null);
  const [credentials, setCredentials] = useState<ViewerCredentials | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [terminated, setTerminated] = useState('');
  const [live, setLive] = useState(false);
  const [slowConnect, setSlowConnect] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [addressDraft, setAddressDraft] = useState<string | null>(null);
  const viewer = useRef<RemoteBrowserHandle>(null);
  const shell = useRef<HTMLDivElement>(null);
  const stageHost = useRef<HTMLDivElement>(null);
  const [stageBox, setStageBox] = useState<{ width: number; height: number } | null>(null);
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

  // A diagnosis is a status read plus the profile's binding state. The POST form
  // also repairs the binding; the automatic read must never write a profile.
  const diagnose = useCallback(async (repairBinding: boolean) => {
    if (repairBinding) setChecking(true);
    try {
      const report = await apiFetch<Diagnosis>(`/api/hermes/browser/diagnose${query(profile)}`,
        repairBinding ? { method: 'POST' } : {});
      const { binding: nextBinding, repair: nextRepair, ...nextStatus } = report;
      if (nextBinding) setBinding(nextBinding);
      if (nextRepair) setRepair(nextRepair);
      setStatus(nextStatus);
      if (repairBinding) setError('');
    } catch (problem) {
      if (repairBinding) setError(errorText(problem));
    } finally {
      if (repairBinding) setChecking(false);
    }
  }, [profile]);

  // The parent remounts this panel per bot (`key={agent.id}`), so there is no
  // profile-change state to reset here; polling is all this needs.
  useEffect(() => {
    let stopped = false;
    const load = () => { if (!stopped) void refresh(); };
    const initial = setTimeout(() => { if (!stopped) void diagnose(false); }, 0);
    const timer = setInterval(load, POLL_MS);
    return () => { stopped = true; clearTimeout(initial); clearInterval(timer); };
  }, [refresh, diagnose]);

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

  // The viewer's socket has its own status line, but it is hidden while the
  // custom chrome is used. Surface a stalled connection instead of leaving a
  // black canvas that looks like an empty page.
  useEffect(() => {
    if (!credentials || live) return;
    const timer = setTimeout(() => setSlowConnect(true), CONNECT_HINT_MS);
    return () => clearTimeout(timer);
  }, [credentials, live]);

  // Leaving native fullscreen (Esc, the component's own exit bar) must also
  // restore the normal panel layout.
  useEffect(() => {
    const sync = () => { if (!document.fullscreenElement) setFullscreen(false); };
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  // Fullscreen gives the stage all remaining height. Fit a true 4:3 rectangle
  // inside it instead of stretching the page into whatever shape the window is.
  useLayoutEffect(() => {
    if (!fullscreen || !credentials) return;
    const host = stageHost.current;
    if (!host) return;
    const fit = () => {
      const width = Math.min(host.clientWidth, (host.clientHeight * 4) / 3);
      setStageBox({ width: Math.floor(width), height: Math.floor((width * 3) / 4) });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    return () => observer.disconnect();
  }, [fullscreen, credentials]);

  const act = useCallback(async (label: string, path: string, init: RequestInit = {}) => {
    setBusy(label);
    try {
      await apiFetch(`/api/hermes/browser${path}${query(profile)}`, { method: 'POST', ...init });
      await refresh();
    } catch (problem) { setError(errorText(problem)); } finally { setBusy(''); }
  }, [profile, refresh]);

  const openViewer = async () => {
    setBusy('open'); setTerminated(''); setError(''); setLive(false); setSlowConnect(false); setAddressDraft(null);
    try {
      if (status?.state !== 'running') {
        const started = await apiFetch<Diagnosis>(`/api/hermes/browser/start${query(profile)}`, { method: 'POST' });
        const { binding: nextBinding, repair: nextRepair, ...nextStatus } = started;
        if (nextBinding) setBinding(nextBinding);
        if (nextRepair) setRepair(nextRepair);
        setStatus(nextStatus);
      }
      const minted = await apiFetch<{
        sessionId: string; viewerToken: string; wsPath: string;
        binding?: BindingReport | null; repair?: BindingRepair;
      }>(`/api/hermes/browser/viewer${query(profile)}`, { method: 'POST' });
      if (minted.binding) setBinding(minted.binding);
      if (minted.repair) setRepair(minted.repair);
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      setCredentials({ sessionId: minted.sessionId, viewerToken: minted.viewerToken, wsUrl: `${scheme}//${window.location.host}${minted.wsPath}` });
      await refresh();
    } catch (problem) { setError(errorText(problem)); } finally { setBusy(''); }
  };

  const exitFullscreen = async () => {
    setFullscreen(false);
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
  };

  const enterFullscreen = async () => {
    setFullscreen(true);
    const element = shell.current;
    if (element?.requestFullscreen) {
      // The CSS overlay is the fallback when a browser or an iframe refuses the
      // Fullscreen API; the toolbar and canvas stay together either way.
      try { await element.requestFullscreen(); } catch { /* overlay remains */ }
    }
  };

  const closeViewer = () => {
    setCredentials(null);
    setCursor(null);
    setLive(false);
    setSlowConnect(false);
    setAddressDraft(null);
    if (fullscreen) void exitFullscreen();
  };

  const holder = status?.control.holder ?? 'agent';
  const interactive = credentials !== null && holder === 'human';
  const bindingOk = Boolean(binding?.configured && !binding.envOverride);

  const onError = useCallback((problem: unknown) => {
    // The viewer gives up reconnecting eventually; say so instead of leaving a
    // frozen canvas that looks like the browser is merely quiet.
    if (problem instanceof Error && problem.message === 'reconnect_exhausted' && credentials) {
      setCredentials(null);
      setCursor(null);
      setLive(false);
      setSlowConnect(false);
      setFullscreen(false);
      setAddressDraft(null);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      setTerminated('The live view lost its connection to the server. Reopen it to continue watching.');
    }
  }, [credentials]);

  if (error && !status) return <Notice error>{error}</Notice>;
  if (!status) return <p className="text-xs md:text-sm text-muted">Checking this bot’s browser…</p>;

  const blankPage = !status.url || status.url === 'about:blank';
  const activeTab = status.tabs.find(tab => tab.active) ?? status.tabs[0];
  const address = status.url || 'about:blank';
  const pageTitle = activeTab?.title?.trim() || status.title?.trim() || (blankPage ? 'New tab' : hostLabel(status.url));
  const secure = status.url.startsWith('https://');

  const submitAddress = () => {
    if (!interactive) return;
    const raw = (addressDraft ?? address).trim();
    if (!raw) return;
    const target = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    try {
      const parsed = new URL(target);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('invalid address');
    } catch {
      setError('Enter an HTTP or HTTPS address without embedded credentials.');
      return;
    }
    setError('');
    setAddressDraft(null);
    viewer.current?.navigate(target);
  };

  return (
    <div
      ref={shell}
      className={fullscreen
        ? 'fixed inset-0 z-50 flex flex-col gap-2 overflow-hidden bg-canvas p-2 md:p-3'
        : 'space-y-3'}
    >
      <div className={fullscreen ? 'shrink-0 space-y-2' : 'space-y-3'}>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={status.state === 'running' ? 'active' : status.state === 'starting' ? 'pending' : 'idle'} label={status.state} />
          <span className="text-xs text-muted">
            {status.viewers > 0 ? `${status.viewers} watching` : 'nobody watching'} · {holder === 'human' ? 'you have control' : 'the bot has control'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className={status.agentConnections > 0 ? 'text-ok' : ''}>
            {status.agentConnections > 0 ? 'The bot is using this browser' : 'The bot has not connected to this browser yet'}
          </span>
          <span>· {status.tabs.length ? `${status.tabs.length} open page${status.tabs.length === 1 ? '' : 's'}` : 'no page open'}</span>
          {status.transport && <span>· {status.transport} transport</span>}
        </div>

        {!status.available && <Notice error>No Chromium-family browser was found on the host, so this bot has no browser to show. Install Chromium, or set HOB_CHROMIUM_PATH.</Notice>}
        {status.transport === 'tcp' && <Notice error>The managed browser is exposing a TCP DevTools port. Production must use the pipe transport.</Notice>}
        {error && <Notice error>{error}</Notice>}
        {status.lastError && <Notice error>{status.lastError}</Notice>}
        {terminated && <Notice>{terminated}</Notice>}
        {binding && <p className={`text-xs leading-relaxed ${bindingOk ? 'text-muted' : 'text-red-700'}`}>{bindingLine(binding)}</p>}
        {repair && !repair.ok && <Notice error>Could not repair this bot’s browser binding: {repair.error ?? 'unknown error'}</Notice>}
        {repair?.ok && repair.changed && <Notice>Repaired this bot’s browser binding. Send it a new message that uses the browser.</Notice>}

        {credentials && status.state === 'running' && status.agentConnections === 0 && (
          <Notice>
            The bot is not connected to this browser yet. If it has already browsed, it was using a different browser. Click “Check bot connection” to repair its profile, then send it a new message that uses the browser.
          </Notice>
        )}
        {credentials && slowConnect && !live && (
          <Notice>
            The live view has not connected yet. This can happen when a proxy blocks WebSocket upgrades.{' '}
            <button type="button" className="font-medium text-accent underline underline-offset-2" onClick={() => { setSlowConnect(false); viewer.current?.reconnect(); }}>Retry connection</button>
          </Notice>
        )}
      </div>

      {!credentials && (
        <div className="space-y-3">
          <Notice>{status.state === 'running'
            ? 'This browser is already running. Open the live view to watch the bot and step in when you need to.'
            : 'Opening the live view starts this bot’s browser. It keeps a single profile, so its logins and open pages carry over between visits.'}</Notice>
          <div className="flex flex-wrap gap-2">
            <button className={buttonClass} disabled={busy !== '' || !status.available} onClick={() => void openViewer()}>
              {status.state === 'running' ? 'Open live view' : 'Start and watch'}
            </button>
            <button className={buttonClass} disabled={checking} onClick={() => void diagnose(true)}>
              {checking ? 'Checking…' : 'Check bot connection'}
            </button>
          </div>
        </div>
      )}

      {credentials && (
        <div className={fullscreen ? 'flex min-h-0 flex-1 flex-col gap-2' : 'space-y-2.5'}>
          <div className={`flex min-h-0 flex-col overflow-hidden bg-panel ${fullscreen ? 'flex-1 border-0' : 'rounded-xl border border-edge shadow-sm'}`}>
            <div className="flex shrink-0 items-end gap-1 border-b border-hair bg-neutral px-2 pt-2">
              <div className="flex min-w-0 max-w-[min(24rem,78%)] items-center gap-2 rounded-t-lg border border-b-0 border-edge bg-surface px-3 py-1.5">
                <Globe2 size={13} className="shrink-0 text-faint" />
                <span className="truncate text-xs font-medium text-ink">{pageTitle}</span>
                {status.loading && <Loader2 size={12} className="shrink-0 animate-spin text-faint" aria-label="Page loading" />}
              </div>
              {status.tabs.length > 1 && (
                <span className="mb-1 rounded-full border border-hair bg-surface px-2 py-0.5 text-[10px] font-medium text-muted">
                  {status.tabs.length} tabs
                </span>
              )}
              <span className="mb-1 ml-auto inline-flex items-center gap-1.5 px-1 text-[10px] font-medium uppercase tracking-wide text-faint">
                <span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-ok-dot' : 'bg-faint'}`} />
                {live ? 'Live' : 'Connecting'}
              </span>
            </div>

            <div className="flex shrink-0 items-center gap-1 border-b border-hair bg-panel px-2 py-1.5">
              <NavButton label="Back" disabled={busy !== ''} onClick={() => viewer.current?.back()}><ArrowLeft size={15} /></NavButton>
              <NavButton label="Forward" disabled={busy !== ''} onClick={() => viewer.current?.forward()}><ArrowRight size={15} /></NavButton>
              <NavButton label="Reload" disabled={busy !== ''} onClick={() => viewer.current?.reload()}><RotateCw size={14} /></NavButton>
              <div className="mx-1 flex min-w-0 flex-1 items-center gap-2 rounded-full border border-edge bg-surface px-3 py-1.5" title={interactive ? 'Type a URL and press Enter' : 'Take control to navigate'}>
                {secure ? <Lock size={12} className="shrink-0 text-ok" /> : <Globe2 size={12} className="shrink-0 text-faint" />}
                <input
                  className={`min-w-0 flex-1 truncate bg-transparent text-xs outline-none ${interactive ? 'text-ink' : 'text-soft'}`}
                  value={addressDraft ?? address}
                  readOnly={!interactive}
                  onChange={event => setAddressDraft(event.target.value)}
                  onBlur={() => setAddressDraft(null)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') submitAddress();
                    else if (event.key === 'Escape') setAddressDraft(null);
                  }}
                  aria-label="Address"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </div>

            <div
              ref={stageHost}
              className={fullscreen ? 'flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#0b0d12]' : 'bg-[#0b0d12]'}
            >
              <div
                className={fullscreen ? 'relative shrink-0 overflow-hidden' : 'relative aspect-[4/3] w-full overflow-hidden'}
                style={fullscreen ? { width: stageBox?.width ?? '100%', height: stageBox?.height ?? '100%' } : undefined}
              >
                <RemoteBrowser
                  ref={viewer}
                  sessionId={credentials.sessionId}
                  viewerToken={credentials.viewerToken}
                  wsUrl={credentials.wsUrl}
                  chrome="none"
                  showSessionStatus={false}
                  interactive={interactive}
                  fullScreen={false}
                  onControlChange={value => {
                    setLive(true);
                    setSlowConnect(false);
                    if (value !== 'human') setAddressDraft(null);
                    setStatus(current => current ? { ...current, control: { ...current.control, holder: value } } : current);
                  }}
                  onTerminated={reason => {
                    setCredentials(null);
                    setCursor(null);
                    setLive(false);
                    setSlowConnect(false);
                    setAddressDraft(null);
                    if (fullscreen) void exitFullscreen();
                    setTerminated(reason === 'idle'
                      ? 'The browser was idle, so it was shut down. Its profile — logins and open pages — is kept; reopen the live view to start it again.'
                      : `The live view ended (${reason}).`);
                    void refresh();
                  }}
                  onError={onError}
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
                />
                {blankPage && <BrowserStartPage live={live} />}
                {/* The agent's own pointer, harvested from the mouse commands it sends.
                    Positioned as a fraction of the browser viewport, which is what the
                    canvas is showing at any scale. */}
                {cursor && status.viewport.w > 0 && status.viewport.h > 0 && (
                  <span
                    aria-hidden
                    className={`pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-1/2 rounded-full ${cursor.kind === 'click' ? 'h-4 w-4 bg-accent/60' : 'h-2.5 w-2.5 bg-accent'}`}
                    style={{ left: `${(cursor.x / status.viewport.w) * 100}%`, top: `${(cursor.y / status.viewport.h) * 100}%` }}
                  />
                )}
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-hair bg-surface px-2 py-2">
              <button className={buttonClass} disabled={holder !== 'agent' || busy !== ''} onClick={() => void act('take', '/control', { body: JSON.stringify({ action: 'take' }) })}>
                <MousePointer2 size={13} /> Take control
              </button>
              <button className={buttonClass} disabled={holder !== 'human' || busy !== ''} onClick={() => void act('release', '/control', { body: JSON.stringify({ action: 'release' }) })}>Return control</button>
              <button className={buttonClass} disabled={checking} onClick={() => void diagnose(true)}>
                {checking ? <><Loader2 size={13} className="animate-spin" /> Checking…</> : 'Check bot connection'}
              </button>
              <button className={buttonClass} onClick={() => void (fullscreen ? exitFullscreen() : enterFullscreen())}>
                {fullscreen ? <><Minimize2 size={13} /> Exit fullscreen</> : <><Maximize2 size={13} /> Fullscreen</>}
              </button>
              <button className={buttonClass} disabled={busy !== ''} onClick={() => void act('stop', '/stop').then(closeViewer)}>
                <Square size={12} /> Stop browser
              </button>
              <button className={buttonClass} onClick={closeViewer}>
                <EyeOff size={13} /> Hide view
              </button>
            </div>
          </div>

          {!fullscreen && !interactive && <p className="text-xs text-muted">The bot is driving. Take control to click and type yourself; the bot’s changes are held until you hand it back.</p>}
          {!fullscreen && interactive && <p className="text-xs text-muted">You are driving. The bot cannot change this page until you return control.</p>}

          {!fullscreen && activity.length > 0 && (
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

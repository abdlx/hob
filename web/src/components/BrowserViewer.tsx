import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { RemoteBrowser, type RemoteBrowserHandle } from '@atriumjs/react';
import { ArrowLeft, ArrowRight, Globe2, Loader2, Lock, MousePointer2, Power, RotateCw, ShieldCheck, Square, X } from 'lucide-react';
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
const CHROME_HEIGHT = 48;
const RAIL_MIN_WIDTH = 230;

const query = (profile: string) => `?profile=${encodeURIComponent(profile)}`;

const primaryButton = 'inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-xs md:text-sm font-semibold text-white hover:bg-accent-strong transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer active:scale-[0.98] shadow-sm';

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

// The browser chrome is deliberately dark and flush with the page. It is a real
// frame around the live Chromium viewport, not another card stacked above it.
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
      className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-100 disabled:cursor-not-allowed disabled:opacity-30"
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

export function BrowserViewer({ profile, botName, navigation, footer, onClose }: {
  profile: string;
  botName?: string;
  navigation?: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
}) {
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
  const [addressDraft, setAddressDraft] = useState<string | null>(null);
  const [split, setSplit] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 1280px)').matches);
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const viewer = useRef<RemoteBrowserHandle>(null);
  const workspace = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1280px)');
    const sync = () => setSplit(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  // The sidebar keeps the browser at a true 4:3 and gives it every pixel of
  // height the viewport can spare. The remaining width belongs to the controls.
  // `ready` matters: the first render is a loading line, so the workspace ref is
  // null until the status arrives.
  const ready = status !== null;
  useLayoutEffect(() => {
    if (!split || !ready) return;
    const host = workspace.current;
    if (!host) return;
    const fit = () => {
      const height = host.clientHeight;
      const width = host.clientWidth;
      if (height <= 0 || width <= 0) return;
      const fromHeight = Math.max(0, (height - CHROME_HEIGHT) * 4 / 3);
      const browserWidth = Math.max(0, Math.min(fromHeight, width - RAIL_MIN_WIDTH));
      if (browserWidth <= 0) return;
      setFrame({
        width: browserWidth,
        height: Math.min(height, browserWidth * 3 / 4 + CHROME_HEIGHT),
      });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    return () => observer.disconnect();
  }, [split, ready]);

  const act = useCallback(async (label: string, path: string, init: RequestInit = {}) => {
    setBusy(label);
    try {
      await apiFetch(`/api/hermes/browser${path}${query(profile)}`, { method: 'POST', ...init });
      await refresh();
      return true;
    } catch (problem) {
      setError(errorText(problem));
      return false;
    } finally {
      setBusy('');
    }
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

  const closeViewer = () => {
    setCredentials(null);
    setCursor(null);
    setLive(false);
    setSlowConnect(false);
    setAddressDraft(null);
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
      setAddressDraft(null);
      setTerminated('The live view lost its connection to the server. Reopen it to continue watching.');
    }
  }, [credentials]);

  if (!status) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-canvas">
        <div className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <Globe2 size={14} className="text-accent" /> Browser
            </p>
            <p className="truncate text-[11px] text-muted">{botName || (profile === 'default' ? 'Main' : profile)}</p>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="Close browser"
              aria-label="Close browser"
              className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted transition-colors hover:bg-black/5 hover:text-ink"
            >
              <X size={18} />
            </button>
          )}
        </div>
        <div className="flex flex-1 items-center justify-center p-4 md:p-6">
          {error
            ? <div className="w-full max-w-md"><Notice error>{error}</Notice></div>
            : <p className="text-xs md:text-sm text-muted">Checking this bot’s browser…</p>}
        </div>
      </div>
    );
  }

  const blankPage = !status.url || status.url === 'about:blank';
  const activeTab = status.tabs.find(tab => tab.active) ?? status.tabs[0];
  const address = status.url || 'about:blank';
  const pageTitle = activeTab?.title?.trim() || status.title?.trim() || (blankPage ? 'New tab' : hostLabel(status.url));
  const secure = status.url.startsWith('https://');
  const off = !credentials;
  const starting = busy === 'open' || status.state === 'starting';

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

  const frameStyle = split && frame.width > 0
    ? { width: `${frame.width}px`, height: `${frame.height}px` }
    : undefined;

  return (
    <div
      ref={workspace}
      className="flex h-full min-h-0 w-full flex-col overflow-y-auto xl:flex-row xl:overflow-hidden"
    >
      {/* Controls live beside the browser, never above or below it. */}
      <aside className="order-2 flex w-full shrink-0 flex-col overflow-x-hidden border-t border-line bg-canvas p-3 xl:order-1 xl:min-w-[230px] xl:flex-1 xl:overflow-y-auto xl:border-r xl:border-t-0 xl:p-4">
        <div className="mx-auto flex w-full max-w-[380px] flex-1 flex-col gap-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                <Globe2 size={14} className="text-accent" /> Browser
              </p>
              <p className="truncate text-[11px] text-muted">{botName || (profile === 'default' ? 'Main' : profile)}</p>
            </div>
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                title="Close browser"
                aria-label="Close browser"
                className="-mr-1 -mt-1 inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted transition-colors hover:bg-black/5 hover:text-ink"
              >
                <X size={18} />
              </button>
            )}
          </div>

          {navigation}

          <div className="rounded-2xl border border-hair bg-surface p-3 shadow-xs">
            <StatusPill status={status.state === 'running' ? 'active' : status.state === 'starting' ? 'pending' : 'idle'} label={status.state} />
            <p className="mt-2 text-xs text-muted">
              {status.viewers > 0 ? `${status.viewers} watching` : 'No viewers'}
              {' · '}
              {credentials
                ? holder === 'human' ? 'you have control' : 'bot control'
                : status.state === 'running' ? 'browser running' : 'browser off'}
            </p>
            {(status.agentConnections > 0 || (status.state === 'running' && !credentials)) && (
              <p className={`mt-1 text-[11px] ${status.agentConnections > 0 ? 'text-ok' : 'text-muted'}`}>
                {status.agentConnections > 0 ? 'The bot is using this browser' : 'The bot is not connected yet'}
              </p>
            )}
          </div>

          <div className="space-y-2">
            {!status.available && <Notice error>No Chromium-family browser was found on the host. Install Chromium, or set HOB_CHROMIUM_PATH.</Notice>}
            {status.transport === 'tcp' && <Notice error>The managed browser is exposing a TCP DevTools port. Production must use the pipe transport.</Notice>}
            {error && <Notice error>{error}</Notice>}
            {status.lastError && <Notice error>{status.lastError}</Notice>}
            {terminated && <Notice>{terminated}</Notice>}
            {binding && !bindingOk && <Notice error>{bindingLine(binding)}</Notice>}
            {repair && !repair.ok && <Notice error>Could not repair this bot’s browser binding: {repair.error ?? 'unknown error'}</Notice>}
            {repair?.ok && repair.changed && <Notice>Repaired this bot’s browser binding. Send it a new message that uses the browser.</Notice>}
            {credentials && status.state === 'running' && status.agentConnections === 0 && (
              <Notice>
                The bot isn’t connected yet. Check the connection, then send a new browser message.
              </Notice>
            )}
            {credentials && slowConnect && !live && (
              <Notice>
                The live view has not connected. A proxy may be blocking WebSocket upgrades.{' '}
                <button type="button" className="font-medium text-accent underline underline-offset-2" onClick={() => { setSlowConnect(false); viewer.current?.reconnect(); }}>Retry</button>
              </Notice>
            )}
          </div>

          <div className="space-y-2">
            {!credentials ? (
              <button className={primaryButton} disabled={busy !== '' || !status.available || status.state === 'starting'} onClick={() => void openViewer()}>
                {starting ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
                {starting ? 'Starting…' : status.state === 'running' ? 'Open live view' : 'Start browser'}
              </button>
            ) : (
              <>
                {holder === 'human' ? (
                  <button className={primaryButton} disabled={busy !== ''} onClick={() => void act('release', '/control', { body: JSON.stringify({ action: 'release' }) })}>
                    Return control to bot
                  </button>
                ) : (
                  <button className={primaryButton} disabled={busy !== ''} onClick={() => void act('take', '/control', { body: JSON.stringify({ action: 'take' }) })}>
                    <MousePointer2 size={14} /> Take control
                  </button>
                )}
                <p className="px-0.5 text-[11px] leading-relaxed text-muted">
                  {holder === 'human' ? 'The bot is paused until you hand control back.' : 'The bot is driving. Take over to click and type yourself.'}
                </p>
              </>
            )}
            <button className={`${buttonClass} w-full`} disabled={checking} onClick={() => void diagnose(true)}>
              {checking ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
              {checking ? 'Checking…' : 'Check bot connection'}
            </button>
            {status.state !== 'stopped' && (
              <button
                className={`${buttonClass} w-full text-red-600 hover:bg-red-50`}
                disabled={busy !== ''}
                onClick={() => void act('stop', '/stop').then(stopped => { if (stopped) closeViewer(); })}
              >
                <Square size={12} /> Stop browser
              </button>
            )}
          </div>

          {credentials && activity.length > 0 && (
            <details className="rounded-xl border border-hair bg-surface px-3 py-2">
              <summary className="cursor-pointer text-[11px] font-medium text-muted">Recent activity</summary>
              <ul className="mt-2 space-y-1">
                {activity.map(entry => (
                  <li key={entry.id} className="text-[11px] text-muted">
                    <span className="text-faint">{new Date(entry.at).toLocaleTimeString()} · </span>{entry.text}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {footer && <div className="mt-auto border-t border-line pt-3">{footer}</div>}
        </div>
      </aside>

      {/* The browser window: one chrome bar attached to a 4:3 viewport. */}
      <div
        className="order-1 flex w-full shrink-0 items-center justify-center bg-[#0b0d12] xl:order-2 xl:h-full"
        style={split && frame.width > 0 ? { width: `${frame.width}px` } : undefined}
      >
        <div
          className="flex w-full max-w-[calc((100dvh_-_3rem)_*_4_/_3)] flex-col overflow-hidden bg-[#0b0d12] shadow-2xl ring-1 ring-black/40"
          style={frameStyle}
        >
          <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-white/10 bg-[#171b22] px-2 text-gray-300">
            <div className="flex min-w-0 max-w-[34%] items-center gap-1.5 rounded-md bg-white/[0.06] px-2 py-1.5">
              <Globe2 size={12} className="shrink-0 text-gray-500" />
              <span className="truncate text-xs font-medium text-gray-200">{off ? 'Browser off' : pageTitle}</span>
              {!off && status.loading && <Loader2 size={11} className="shrink-0 animate-spin text-gray-500" aria-label="Page loading" />}
            </div>

            <NavButton label="Back" disabled={off || busy !== ''} onClick={() => viewer.current?.back()}><ArrowLeft size={15} /></NavButton>
            <NavButton label="Forward" disabled={off || busy !== ''} onClick={() => viewer.current?.forward()}><ArrowRight size={15} /></NavButton>
            <NavButton label="Reload" disabled={off || busy !== ''} onClick={() => viewer.current?.reload()}><RotateCw size={14} /></NavButton>

            <div
              className={`mx-0.5 flex min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-1.5 ring-1 ring-inset ${off ? 'bg-black/20 ring-white/5' : 'bg-black/30 ring-white/10'}`}
              title={off ? 'The browser is off' : interactive ? 'Type a URL and press Enter' : 'Take control to navigate'}
            >
              {secure && !off ? <Lock size={12} className="shrink-0 text-emerald-400" /> : <Globe2 size={12} className="shrink-0 text-gray-500" />}
              <input
                className={`min-w-0 flex-1 truncate bg-transparent text-xs outline-none ${interactive ? 'text-gray-100' : 'text-gray-500'}`}
                value={off ? 'about:blank' : addressDraft ?? address}
                readOnly={off || !interactive}
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

            <span className="hidden shrink-0 items-center gap-1.5 px-1 text-[10px] font-medium uppercase tracking-wide text-gray-500 sm:inline-flex">
              <span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-emerald-400' : credentials || status.state === 'starting' ? 'animate-pulse bg-amber-400' : 'bg-gray-600'}`} />
              {live ? 'Live' : credentials ? 'Connecting' : status.state === 'starting' ? 'Starting' : 'Off'}
            </span>

            {onClose && (
              <button
                type="button"
                onClick={onClose}
                title="Close browser"
                aria-label="Close browser"
                className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-100 xl:hidden"
              >
                <X size={15} />
              </button>
            )}
          </div>

          <div className={`relative min-h-0 overflow-hidden bg-[#0b0d12] ${split ? 'flex-1' : 'aspect-[4/3] w-full'}`}>
            {credentials ? (
              <>
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
                    setTerminated(reason === 'idle'
                      ? 'The browser was idle, so it was shut down. Its profile — logins and open pages — is kept; reopen the live view to start it again.'
                      : `The live view ended (${reason}).`);
                    void refresh();
                  }}
                  onError={onError}
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
                />
                {blankPage && <BrowserStartPage live={live} />}
                {!live && !blankPage && (
                  <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-[#0b0d12]/70">
                    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-gray-300">
                      <Loader2 size={13} className="animate-spin" /> Connecting to the live view…
                    </span>
                  </div>
                )}
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
              </>
            ) : (
              <button
                type="button"
                onClick={() => void openViewer()}
                disabled={busy !== '' || !status.available || status.state === 'starting'}
                className="group absolute inset-0 flex cursor-pointer flex-col items-center justify-center gap-4 bg-[radial-gradient(circle_at_50%_38%,rgba(59,130,246,0.10),transparent_55%),#0b0d12] text-center disabled:cursor-default"
              >
                <span className="flex h-16 w-16 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-gray-400 shadow-inner transition-colors group-hover:border-white/20 group-hover:text-gray-200">
                  {starting ? <Loader2 size={26} className="animate-spin" /> : <Power size={26} />}
                </span>
                <span className="space-y-1.5">
                  <span className="block text-sm font-semibold text-gray-200">
                    {starting
                      ? 'Starting the browser…'
                      : status.available
                        ? status.state === 'running' ? 'Live view is off' : 'The browser is off'
                        : 'No browser available'}
                  </span>
                  <span className="mx-auto block max-w-[18rem] text-xs leading-relaxed text-gray-500">
                    {!status.available
                      ? 'No Chromium-family browser was found on the host. Check the server setup, then try again.'
                      : status.state === 'running'
                        ? 'Click the screen to watch this bot’s browser and take control when you need to.'
                        : 'Click the screen to start this bot’s browser. Logins and open pages are kept between visits.'}
                  </span>
                </span>
                {status.available && !starting && (
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-medium text-gray-400">
                    {status.state === 'running' ? 'Open live view' : 'Start browser'}
                  </span>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

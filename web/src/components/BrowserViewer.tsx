import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { RemoteBrowser, type RemoteBrowserHandle } from '@atriumjs/react';
import {
  ArrowLeft,
  ArrowRight,
  Globe2,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  MousePointer2,
  Plus,
  Power,
  RotateCw,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react';
import { apiFetch } from '../services/api';
import { Notice, StatusPill } from './WorkspaceUI';
import { errorText } from './workspaceUtils';

// Live viewer for a bot's persistent, HOB-managed browser.
//
// The page is rendered by `@atriumjs/react` over the Atrium protocol. Everything
// around it — starting the browser, who holds control, what the agent is doing,
// which tabs exist — is HOB's own surface, because those are exactly the things
// HOB enforces and the viewer must not be able to disagree with the gateway about.

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
interface Cursor { x: number; y: number; kind: 'move' | 'click'; n?: number }

const POLL_MS = 2000;
const ACTIVITY_LIMIT = 6;
const CONNECT_HINT_MS = 8000;

const query = (profile: string) => `?profile=${encodeURIComponent(profile)}`;

const primaryButton = 'inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white hover:bg-accent-strong transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer active:scale-[0.98] shadow-sm';

const quietButton = 'inline-flex w-full items-center justify-center gap-1 rounded-lg border border-hair bg-surface px-2 py-1.5 text-[11px] font-medium text-ink transition-colors hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer';

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

/** A tab title that reads like Chrome's: page title, then host, then "New Tab". */
function tabLabel(tab: BrowserTab): string {
  const title = tab.title.trim();
  if (title && !/^(?:about|chrome|https?):/i.test(title)) return title;
  const url = tab.url.trim();
  if (!url || url === 'about:blank' || url.startsWith('chrome://')) return 'New Tab';
  try { return new URL(url).hostname || url; } catch { return url; }
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
      className="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-100 disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function BrowserStartPage({ live }: { live: boolean }) {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2.5 px-4 text-center"
      style={{ background: 'radial-gradient(ellipse at top, #EEF4FF 0%, #F8FAFC 55%, #F1F5F9 100%)' }}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-accent-line bg-surface/80 shadow-sm">
        <Globe2 size={20} className="text-accent" />
      </div>
      <div className="space-y-1">
        <p className="text-xs font-semibold text-ink">The bot’s browser is ready</p>
        <p className="mx-auto max-w-[14rem] text-[10px] leading-relaxed text-muted">
          Send a message that uses the browser. Its page will appear here.
        </p>
      </div>
      <p className="inline-flex items-center gap-1.5 text-[10px] text-faint">
        {live ? 'Waiting for the bot to open a page.' : <><Loader2 size={10} className="animate-spin" /> Connecting to the live view…</>}
      </p>
    </div>
  );
}

export function BrowserViewer({ profile, botName, avatarUrl, footer }: {
  profile: string;
  botName?: string;
  avatarUrl?: string;
  footer?: ReactNode;
}) {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [tabBusy, setTabBusy] = useState('');
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
  const [expanded, setExpanded] = useState(false);
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
        setCursor({ x: payload.x, y: payload.y, kind: 'click', n: Date.now() });
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

  // Escape leaves the full-screen browser without killing the live view.
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [expanded]);

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
    setExpanded(true);
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
      setCredentials({ sessionId: minted.sessionId, viewerToken: minted.viewerToken, wsUrl: `${scheme}//${window.location.host}${minted.wsPath}${query(profile)}` });
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

  /** A dashboard tab click takes human control; it never mutates a bot-owned tab. */
  const tabAction = useCallback(async (action: 'activate' | 'close' | 'new', payload: Record<string, string> = {}) => {
    setTabBusy(action); setError('');
    try {
      const next = await apiFetch<BrowserStatus>(`/api/hermes/browser/tabs/${action}${query(profile)}`, {
        method: 'POST', body: JSON.stringify(payload),
      });
      setStatus(next);
      return true;
    } catch (problem) {
      setError(errorText(problem));
      return false;
    } finally {
      setTabBusy('');
    }
  }, [profile]);

  const selectTab = async (tabId: string) => {
    setExpanded(true);
    const ok = await tabAction('activate', { tabId });
    if (ok && !credentials) await openViewer();
  };

  const closeTab = async (tabId: string) => {
    await tabAction('close', { tabId });
  };

  const newTab = async () => {
    setExpanded(true);
    const ok = await tabAction('new', {});
    if (ok && !credentials) await openViewer();
  };

  const holder = status?.control.holder ?? 'agent';
  const interactive = credentials !== null && holder === 'human';
  const bindingOk = Boolean(binding?.configured && !binding.envOverride);

  // The agent's pointer stays on screen for as long as the bot holds control:
  // mouse commands and scripted actions both move it, and if the bot has not
  // acted yet it waits in the middle instead of appearing from nowhere.
  const viewport = status?.viewport;
  const showCursor = Boolean(credentials) && holder === 'agent' && (viewport?.w ?? 0) > 0 && (viewport?.h ?? 0) > 0;
  const pointer: Cursor | null = showCursor && viewport
    ? cursor ?? { x: viewport.w / 2, y: viewport.h / 2, kind: 'move' }
    : null;

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
      <div className="space-y-3">
        <div className="aspect-[5/4] w-full animate-pulse rounded-xl bg-sunken" />
        {error
          ? <Notice error>{error}</Notice>
          : <p className="text-xs text-muted">Checking this bot’s browser…</p>}
      </div>
    );
  }

  const blankPage = !status.url || /^(?:about:blank|chrome:\/\/(?:newtab|new-tab-page)\/?)$/.test(status.url);
  const address = status.url || 'about:blank';
  const secure = status.url.startsWith('https://');
  const off = !credentials;
  const starting = busy === 'open' || status.state === 'starting';
  const tabs = status.tabs;

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

  const windowFrame = (
    <div className="overflow-hidden rounded-xl border border-black/30 bg-[#0b0d12] shadow-sm">
      {/* Chrome-like tab strip. It is always visible, even while the browser is
          off, so the tab count and the new-tab action do not appear from nowhere
          the first time the bot browses. */}
      <div className="flex h-9 shrink-0 items-end gap-0.5 border-b border-black/40 bg-[#0b0d12] px-1.5 pt-1">
        <div className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto" role="tablist" aria-label="Browser tabs">
          {tabs.length === 0 ? (
            <div className="flex h-8 min-w-0 max-w-[220px] flex-1 items-center gap-2 rounded-t-lg bg-[#1c2028] px-3 text-[11px] text-gray-300">
              <Globe2 size={11} className="shrink-0 text-gray-500" />
              <span className="truncate">New Tab</span>
            </div>
          ) : tabs.map(tab => {
            const current = tab.active;
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={current}
                className={`group flex h-8 min-w-0 max-w-[220px] flex-1 items-center gap-2 rounded-t-lg px-2.5 text-[11px] transition-colors ${
                  current ? 'bg-[#1c2028] text-gray-100' : 'bg-transparent text-gray-500 hover:bg-white/5 hover:text-gray-300'
                }`}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                  onClick={() => void selectTab(tab.id)}
                  title={tab.title || tab.url || 'New Tab'}
                  disabled={tabBusy !== ''}
                >
                  <Globe2 size={11} className={`shrink-0 ${tab.url.startsWith('https://') ? 'text-emerald-400' : 'text-gray-500'}`} />
                  <span className="truncate">{tabLabel(tab)}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Close ${tabLabel(tab)}`}
                  title={tabs.length > 1 ? 'Close tab' : 'The last tab stays open so the browser keeps running'}
                  disabled={tabBusy !== '' || tabs.length <= 1}
                  onClick={() => void closeTab(tab.id)}
                  className="shrink-0 cursor-pointer rounded p-0.5 opacity-0 transition-opacity hover:bg-white/15 group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-20"
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>
        <NavButton label="New tab" disabled={tabBusy !== '' || !status.available} onClick={() => void newTab()}>
          {tabBusy === 'new' ? <Loader2 size={12} className="animate-spin" /> : <Plus size={13} />}
        </NavButton>
        <NavButton label={expanded ? 'Exit full screen' : 'Full screen'} onClick={() => setExpanded(value => !value)}>
          {expanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </NavButton>
      </div>

      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-white/10 bg-[#171b22] px-1.5 text-gray-300">
        <NavButton label="Back" disabled={off || busy !== ''} onClick={() => viewer.current?.back()}><ArrowLeft size={13} /></NavButton>
        <NavButton label="Forward" disabled={off || busy !== ''} onClick={() => viewer.current?.forward()}><ArrowRight size={13} /></NavButton>
        <NavButton label="Reload" disabled={off || busy !== ''} onClick={() => viewer.current?.reload()}><RotateCw size={12} /></NavButton>

        <div
          className={`mx-0.5 flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 ring-1 ring-inset ${off ? 'bg-black/20 ring-white/5' : 'bg-black/30 ring-white/10'}`}
          title={off ? 'The browser is off' : interactive ? 'Type a URL and press Enter' : 'Take control to navigate'}
        >
          {secure && !off ? <Lock size={10} className="shrink-0 text-emerald-400" /> : <Globe2 size={10} className="shrink-0 text-gray-500" />}
          <input
            className={`min-w-0 flex-1 truncate bg-transparent text-[11px] outline-none ${interactive ? 'text-gray-100' : 'text-gray-500'}`}
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
          {!off && status.loading && <Loader2 size={10} className="shrink-0 animate-spin text-gray-500" aria-label="Page loading" />}
        </div>

        <span
          className="inline-flex shrink-0 items-center gap-1 px-0.5 text-[9px] font-medium uppercase tracking-wide text-gray-500"
          title={live ? 'Live view connected' : credentials ? 'Connecting to the live view' : status.state === 'starting' ? 'Starting the browser' : 'The browser is off'}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-emerald-400' : credentials || status.state === 'starting' ? 'animate-pulse bg-amber-400' : 'bg-gray-600'}`} />
          {live ? 'Live' : !credentials && !starting ? 'Off' : null}
        </span>

        {/* The bot's own profile picture, exactly where a browser shows the
            person using it. It is the same avatar as the bot's sidebar entry. */}
        <img
          src={avatarUrl || '/brand/hob-mark.png'}
          alt={botName ? `${botName} profile` : 'Bot profile'}
          title={botName || 'Bot profile'}
          className="ml-0.5 h-5 w-5 shrink-0 rounded-full border border-white/15 bg-white/5 object-cover"
          onError={event => { event.currentTarget.src = '/brand/hob-mark.png'; }}
        />
      </div>

      <div className="relative aspect-[5/4] w-full overflow-hidden bg-[#0b0d12]">
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
                <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/40 px-3 py-1.5 text-[11px] text-gray-300">
                  <Loader2 size={12} className="animate-spin" /> Connecting to the live view…
                </span>
              </div>
            )}
            {/* The agent's own pointer, harvested from the mouse commands it sends
                and from the focused element of scripted actions. Positioned as a
                fraction of the browser viewport, which is what the canvas is
                showing at any scale. The CSS transition is purely visual: CDP has
                already run by the time this moves. */}
            {pointer && (
              <span
                aria-hidden
                className="pointer-events-none absolute z-20 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]"
                style={{
                  left: `${(pointer.x / status.viewport.w) * 100}%`,
                  top: `${(pointer.y / status.viewport.h) * 100}%`,
                  transition: 'left 190ms cubic-bezier(0.16, 1, 0.3, 1), top 190ms cubic-bezier(0.16, 1, 0.3, 1)',
                }}
              >
                {pointer.kind === 'click' && (
                  <span key={pointer.n} className="hob-agent-click absolute -left-1 -top-1 h-4 w-4 rounded-full bg-accent/60" />
                )}
                <MousePointer2 size={22} fill="currentColor" stroke="black" strokeWidth={1.5} />
                <span className="absolute left-4 top-4 rounded-full bg-black/75 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-white">
                  Bot
                </span>
              </span>
            )}
          </>
        ) : (
          <button
            type="button"
            onClick={() => { setExpanded(true); void openViewer(); }}
            disabled={busy !== '' || !status.available || status.state === 'starting'}
            className="group absolute inset-0 flex cursor-pointer flex-col items-center justify-center gap-2.5 bg-[radial-gradient(circle_at_50%_38%,rgba(59,130,246,0.10),transparent_55%),#0b0d12] px-4 text-center disabled:cursor-default"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-gray-400 shadow-inner transition-colors group-hover:border-white/20 group-hover:text-gray-200">
              {starting ? <Loader2 size={20} className="animate-spin" /> : <Power size={20} />}
            </span>
            <span className="space-y-1">
              <span className="block text-xs font-semibold text-gray-200">
                {starting
                  ? 'Starting the browser…'
                  : status.available
                    ? status.state === 'running' ? 'Live view is off' : 'The browser is off'
                    : 'No browser available'}
              </span>
              <span className="mx-auto block max-w-[14rem] text-[10px] leading-relaxed text-gray-500">
                {!status.available
                  ? 'No Chromium-family browser was found on the host.'
                  : status.state === 'running'
                    ? 'Click to watch this bot’s browser.'
                    : 'Click to start this bot’s browser.'}
              </span>
            </span>
          </button>
        )}
      </div>
    </div>
  );

  const controls = (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <StatusPill status={status.state === 'running' ? 'active' : status.state === 'starting' ? 'pending' : 'idle'} label={status.state} />
        <span className="min-w-0 truncate text-[11px] text-muted">
          {status.viewers > 0 ? `${status.viewers} watching` : 'No viewers'}
          {' · '}
          {credentials
            ? holder === 'human' ? 'you have control' : 'bot control'
            : status.state === 'running' ? 'browser running' : 'browser off'}
        </span>
      </div>

      {!status.available && <Notice error>No Chromium-family browser was found on the host. Install Chromium, or set HOB_CHROMIUM_PATH.</Notice>}
      {status.transport === 'tcp' && <Notice error>The managed browser is exposing a TCP DevTools port. Production must use the pipe transport.</Notice>}
      {error && <Notice error>{error}</Notice>}
      {status.lastError && <Notice error>{status.lastError}</Notice>}
      {terminated && <Notice>{terminated}</Notice>}
      {binding && !bindingOk && <Notice error>{bindingLine(binding)}</Notice>}
      {repair && !repair.ok && <Notice error>Could not repair this bot’s browser binding: {repair.error ?? 'unknown error'}</Notice>}
      {repair?.ok && repair.changed && <Notice>Repaired this bot’s browser binding. Send it a new message that uses the browser.</Notice>}
      {credentials && status.state === 'running' && status.agentConnections === 0 && (
        <p className="rounded-lg bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-800">
          The bot isn’t connected yet. Check the connection, then try again.
        </p>
      )}
      {credentials && slowConnect && !live && (
        <p className="rounded-lg bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-800">
          The live view has not connected. A proxy may be blocking WebSocket upgrades.{' '}
          <button type="button" className="font-medium text-accent underline underline-offset-2" onClick={() => { setSlowConnect(false); viewer.current?.reconnect(); }}>Retry</button>
        </p>
      )}

      {!credentials ? (
        <button className={primaryButton} disabled={busy !== '' || !status.available || status.state === 'starting'} onClick={() => void openViewer()}>
          {starting ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />}
          {starting ? 'Starting…' : status.state === 'running' ? 'Open live view' : 'Start browser'}
        </button>
      ) : holder === 'human' ? (
        <button className={primaryButton} disabled={busy !== ''} onClick={() => void act('release', '/control', { body: JSON.stringify({ action: 'release' }) })}>
          Return control to bot
        </button>
      ) : (
        <button className={primaryButton} disabled={busy !== ''} onClick={() => void act('take', '/control', { body: JSON.stringify({ action: 'take' }) })}>
          <MousePointer2 size={13} /> Take control
        </button>
      )}

      <div className={`grid gap-2 ${status.state !== 'stopped' ? 'grid-cols-2' : 'grid-cols-1'}`}>
        <button className={quietButton} disabled={checking} onClick={() => void diagnose(true)} title="Check the bot’s browser connection">
          {checking ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
          {checking ? 'Checking…' : 'Check bot'}
        </button>
        {status.state !== 'stopped' && (
          <button
            className={`${quietButton} text-red-600 hover:bg-red-50`}
            disabled={busy !== ''}
            onClick={() => void act('stop', '/stop').then(stopped => { if (stopped) closeViewer(); })}
            title="Stop the browser"
          >
            <Square size={11} /> Stop
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div
      className={expanded
        ? 'fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-3 backdrop-blur-sm sm:p-6'
        : 'space-y-3'}
      onClick={expanded ? event => { if (event.target === event.currentTarget) setExpanded(false); } : undefined}
    >
      <div
        className={expanded ? 'my-auto w-full space-y-3' : 'space-y-3'}
        style={expanded ? { maxWidth: 'min(96vw, calc(72vh * 5 / 4))' } : undefined}
      >
        {expanded && (
          <div className="flex items-center justify-between gap-2 px-1 text-gray-200">
            <span className="inline-flex min-w-0 items-center gap-2 text-xs font-medium">
              <img
                src={avatarUrl || '/brand/hob-mark.png'}
                alt=""
                className="h-5 w-5 rounded-full border border-white/20 object-cover"
                onError={event => { event.currentTarget.src = '/brand/hob-mark.png'; }}
              />
              <span className="truncate">{botName ? `${botName}’s browser` : 'Bot browser'}</span>
            </span>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              aria-label="Close full-screen browser"
              title="Close full-screen browser (Esc)"
              className="rounded-md p-1.5 text-gray-300 transition-colors hover:bg-white/10 hover:text-white cursor-pointer"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {windowFrame}
        {controls}

        {credentials && activity.length > 0 && (
          <details className="rounded-lg border border-hair bg-surface px-2.5 py-2">
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

        {footer && <div className="border-t border-line pt-3">{footer}</div>}
      </div>
    </div>
  );
}

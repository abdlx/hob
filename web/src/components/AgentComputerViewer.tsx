import { useCallback, useEffect, useRef, useState } from 'react';
// @ts-expect-error RFB has no types
import RFB from '@novnc/novnc';
import {
  Monitor,
  Power,
  Play,
  Moon,
  RotateCw,
  Maximize2,
  Minimize2,
  Loader2,
  Cpu,
  HardDrive,
  MousePointer,
  X,
} from 'lucide-react';
import { apiFetch } from '../services/api';
import { Notice, Skeleton } from './WorkspaceUI';
import { errorText } from './workspaceUtils';
import { createComputerStream, resolveRfbConstructor } from '../services/computer-stream';
import type { ComputerConnectionState } from '../services/computer-stream';

interface Computer {
  id: string;
  name: string;
  state: 'ready' | 'sleeping' | 'starting' | 'stopped' | 'unhealthy' | string;
  cpuMillis?: number;
  memoryMb?: number;
  health?: {
    ok?: boolean;
    display?: string;
    screen?: { width: number; height: number };
    cursor?: { x: number; y: number };
    control?: { owner: string; since: number; reason: string };
    counters?: { moves: number; clicks: number; keys: number; screenshots: number };
    browser_engine?: string;
  };
}

interface AgentComputerStatus {
  configured?: boolean;
  connected: boolean;
  serverName?: string;
  origin?: string;
  mcpUrl?: string;
  vncToken?: string;
  directWsUrl?: string;
  computers?: Computer[];
  computer?: Computer | null;
  error?: string;
}

export function AgentComputerViewer({ profile }: { profile: string }) {
  const [status, setStatus] = useState<AgentComputerStatus | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [connState, setConnState] = useState<ComputerConnectionState>('idle');
  const [expanded, setExpanded] = useState(false);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<ReturnType<typeof createComputerStream> | null>(null);
  const mounted = useRef(false);
  const revision = useRef(0);
  const invalidate = useCallback(() => { revision.current++; }, []);
  const loadStatus = useCallback(async () => {
    const current = ++revision.current;
    try {
      const data = await apiFetch<AgentComputerStatus>(`/api/hermes/agent-computer/status?profile=${encodeURIComponent(profile)}`, { headers: { 'X-Hob-Profile': profile } });
      if (mounted.current && current === revision.current) { setStatus(data); setError(data.error || ''); }
    } catch (cause) { if (mounted.current && current === revision.current) setError(errorText(cause)); }
  }, [profile]);
  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await loadStatus(); if (!stopped) timer = setTimeout(poll, 4000); };
    void poll();
    return () => { stopped = true; mounted.current = false; invalidate(); clearTimeout(timer); };
  }, [loadStatus, invalidate]);
  const activeComputer = status?.computer || status?.computers?.[0] || null;
  const id = activeComputer?.id;
  const isRunning = status?.connected === true && activeComputer?.state === 'ready';
  const origin = status?.origin;
  const token = status?.vncToken;
  useEffect(() => {
    if (!isRunning || !id || !screenRef.current) return;
    const element = screenRef.current;
    const Constructor = resolveRfbConstructor(RFB);
    const proxyUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/hermes/agent-computer/vnc?profile=${encodeURIComponent(profile)}&computerId=${encodeURIComponent(id)}`;
    const directUrl = origin && token ? `${origin.replace(/^http/, 'ws')}/api/computers/${encodeURIComponent(id)}/vnc?token=${encodeURIComponent(token)}` : '';
    const stream = createComputerStream({ directUrl, proxyUrl, onState: setConnState, onError: setError,
      create(url) {
        element.replaceChildren();
        const client = new Constructor(element, url, { wsProtocols: ['binary'] });
        client.scaleViewport = true; client.clipViewport = false; client.background = '#000000';
        client.qualityLevel = 6; client.compressionLevel = 2;
        // Preserve the existing TigerVNC compatibility encodings; cursor pixels
        // come from the server and continuous updates are deliberately omitted.
        client._sendEncodings = function () {
          const encodings = [1, ...(this._fbDepth === 24 ? [7, -260, 16, 21, 5, 2] : []), 0,
            -32 + this._qualityLevel, -256 + this._compressionLevel, -223, -224, -258, -261, -308, -309, -312, -307, 0xc0a1e5ce];
          Constructor.messages.clientEncodings(this._sock, encodings);
        };
        return client;
      },
    });
    streamRef.current = stream;
    stream.connect();
    const update = () => { if (document.visibilityState === 'visible') stream.requestUpdate(client => Constructor.messages.fbUpdateRequest(client._sock, true, 0, 0, client._fbWidth, client._fbHeight)); };
    const pump = setInterval(update, 40);
    document.addEventListener('visibilitychange', update);
    return () => { clearInterval(pump); document.removeEventListener('visibilitychange', update); stream.close(); streamRef.current = null; element.replaceChildren(); };
  }, [profile, id, isRunning, origin, token]);
  const control = async (action: 'wake' | 'sleep') => {
    if (!id || busy) return;
    setBusy(action); setError('');
    try {
      await apiFetch(`/api/hermes/agent-computer/${action}?profile=${encodeURIComponent(profile)}`, { method: 'POST', headers: { 'X-Hob-Profile': profile }, body: JSON.stringify({ computerId: id }) });
      if (mounted.current) await loadStatus();
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { if (mounted.current) setBusy(''); }
  };
  const handleWake = () => control('wake');
  const handleSleep = () => control('sleep');
  if (!status) return error ? <Notice error>{error}</Notice> : <Skeleton className="h-40 w-full" />;
  if (!status.connected && !status.configured) return <Notice>No agent computer is configured for this bot. Connect one in Tools &amp; computer settings.</Notice>;
  const isWaking = busy === 'wake' || activeComputer?.state === 'starting';
  const isSleeping = busy === 'sleep';
  const displayState = !status.connected ? 'unavailable' : isWaking ? 'Starting...' : isSleeping ? 'Sleeping...' : activeComputer?.state || 'Unknown';

  const windowFrame = (
    <div className="overflow-hidden rounded-xl border border-black/30 bg-[#0b0d12] shadow-sm">
      {/* Title / Action bar */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-black/40 bg-[#0b0d12] px-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <Monitor size={13} className="shrink-0 text-accent" />
          <span className="text-[11px] font-semibold text-gray-200 truncate">
            {activeComputer?.name || 'Agent Computer'}
          </span>
          <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px]">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                isRunning
                  ? 'bg-emerald-400'
                  : isWaking
                  ? 'animate-pulse bg-amber-400'
                  : 'bg-gray-500'
              }`}
            />
            <span className="text-gray-300 font-medium capitalize">{displayState}</span>
          </span>
        </div>

        <div className="flex items-center gap-1">
          {isRunning ? (
            <button
              type="button"
              disabled={busy !== ''}
              onClick={handleSleep}
              title="Put computer to sleep"
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 transition-colors cursor-pointer disabled:opacity-40"
            >
              {isSleeping ? <Loader2 size={11} className="animate-spin" /> : <Moon size={11} />}
              <span>Sleep</span>
            </button>
          ) : (
            <button
              type="button"
              disabled={busy !== ''}
              onClick={handleWake}
              title="Wake computer"
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 transition-colors cursor-pointer disabled:opacity-40"
            >
              {isWaking ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
              <span>Wake</span>
            </button>
          )}

          <button
            type="button"
            disabled={busy !== ''}
            onClick={() => { void loadStatus(); if (connState === 'failed' || connState === 'disconnected') streamRef.current?.reconnect(); }}
            title="Refresh status"
            className="p-1 rounded text-gray-400 hover:text-gray-200 hover:bg-white/5 transition-colors cursor-pointer"
          >
            <RotateCw size={11} className={busy === 'loading' ? 'animate-spin' : ''} />
          </button>

          <button
            type="button"
            onClick={() => setExpanded(prev => !prev)}
            title={expanded ? 'Exit full screen' : 'Full screen'}
            className="p-1 rounded text-gray-400 hover:text-gray-200 hover:bg-white/5 transition-colors cursor-pointer"
          >
            {expanded ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
          </button>
        </div>
      </div>

      {/* Screen container */}
      <div className="relative aspect-[16/10] w-full overflow-hidden bg-black flex items-center justify-center">
        {isRunning ? (
          <>
            <div
              ref={screenRef}
              className="w-full h-full cursor-default select-none overflow-hidden [&>div]:w-full [&>div]:h-full [&_canvas]:w-full [&_canvas]:h-full [&_canvas]:object-contain"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            />
            {connState === 'connecting' && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur-[1px]">
                <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/60 px-3 py-1.5 text-[11px] text-gray-200 shadow-lg">
                  <Loader2 size={13} className="animate-spin text-accent" />
                  <span>Connecting to live desktop...</span>
                </span>
              </div>
            )}
            {/* Live streaming status watermark */}
            <div className="pointer-events-none absolute bottom-2 right-2 z-20 flex items-center gap-1.5 rounded-md bg-black/70 px-2 py-1 border border-white/10 text-[10px] text-gray-300">
              <span className={`h-1.5 w-1.5 rounded-full ${connState === 'connected' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
              <span>{connState === 'connected' ? 'Live stream' : connState === 'failed' ? 'Disconnected' : 'Connecting'}</span>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center p-6 text-center space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-gray-400 shadow-inner">
              {isWaking ? (
                <Loader2 size={24} className="animate-spin text-accent" />
              ) : (
                <Power size={22} className="text-gray-400" />
              )}
            </div>
            <div className="space-y-1 max-w-xs">
              <p className="text-xs font-semibold text-gray-200">
                {!status.connected ? 'Computer service unavailable' : isWaking ? 'Waking agent computer...' : activeComputer ? 'Agent computer is not running' : 'No computer is available'}
              </p>
              <p className="text-[11px] text-gray-400 leading-relaxed">
                {!status.connected ? "Check this bot's computer connection and credentials, then refresh." : isWaking
                  ? 'Booting guest desktop and starting agent services...'
                  : 'Screen stream paused to save resources. Wake it anytime to watch live or take control.'}
              </p>
            </div>
            {!isWaking && activeComputer && status.connected && (
              <button
                type="button"
                disabled={busy !== ''}
                onClick={handleWake}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-accent hover:bg-accent-strong text-white text-xs font-semibold shadow-md transition-all active:scale-[0.98] cursor-pointer"
              >
                <Power size={13} />
                <span>Wake Computer</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Footer controls & specs */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-white/10 bg-[#12151b] text-[11px] text-gray-400">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-gray-300">
            <Cpu size={12} className="text-gray-500" />
            <span>{activeComputer?.cpuMillis ? `${(activeComputer.cpuMillis / 1000).toFixed(1)} vCPU` : '1 vCPU'}</span>
          </span>
          <span className="flex items-center gap-1 text-gray-300">
            <HardDrive size={12} className="text-gray-500" />
            <span>{activeComputer?.memoryMb ? `${activeComputer.memoryMb} MB` : '1024 MB'}</span>
          </span>
          {activeComputer?.health?.browser_engine && (
            <span className="text-faint capitalize">{activeComputer.health.browser_engine} browser</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {activeComputer?.health?.control?.owner && (
            <span className="flex items-center gap-1 text-[10px] text-gray-400">
              <MousePointer size={10} className="text-accent" />
              <span>Control: <strong className="text-gray-200 font-medium capitalize">{activeComputer.health.control.owner}</strong></span>
            </span>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div
      className={
        expanded
          ? 'fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/80 p-4 backdrop-blur-sm'
          : 'space-y-2 pt-2'
      }
      onClick={expanded ? e => { if (e.target === e.currentTarget) setExpanded(false); } : undefined}
    >
      <div
        className={expanded ? 'w-full max-w-5xl space-y-2' : 'space-y-2'}
      >
        {expanded && (
          <div className="flex items-center justify-between text-gray-200 pb-1">
            <span className="inline-flex items-center gap-2 text-sm font-semibold">
              <Monitor size={15} className="text-accent" />
              <span>{activeComputer?.name || 'Agent Computer'}</span>
            </span>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="p-1 rounded text-gray-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            >
              <X size={18} />
            </button>
          </div>
        )}

        {/* Section title when embedded in panel */}
        {!expanded && (
          <div className="flex items-center justify-between px-0.5 pt-1 pb-0.5">
            <span className="text-[12px] font-semibold text-ink flex items-center gap-1.5">
              <Monitor size={13} className="text-accent" />
              <span>Agent Computer</span>
            </span>
            <span className="text-[10px] text-muted font-mono">
              {status.serverName || 'agent_computer'}
            </span>
          </div>
        )}

        {error && <Notice error>{error}</Notice>}
        {windowFrame}
      </div>
    </div>
  );
}

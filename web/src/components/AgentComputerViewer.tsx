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
import { Notice } from './WorkspaceUI';
import { errorText } from './workspaceUtils';

function resolveRFB(raw: any) {
  let ctor = raw;
  while (ctor && typeof ctor !== 'function' && ctor.default) {
    ctor = ctor.default;
  }
  return ctor;
}

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
  connected: boolean;
  serverName?: string;
  origin?: string;
  computers?: Computer[];
  computer?: Computer | null;
  error?: string;
}

export function AgentComputerViewer({ profile }: { profile: string }) {
  const [status, setStatus] = useState<AgentComputerStatus | null>(null);
  const [busy, setBusy] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [connState, setConnState] = useState<'idle' | 'connecting' | 'connected' | 'failed' | 'disconnected'>('idle');
  const [expanded, setExpanded] = useState<boolean>(false);
  const [selectedCompId, setSelectedCompId] = useState<string>('');

  const screenRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<any>(null);
  const isConnectedRef = useRef(false);
  const isConnectingRef = useRef(false);
  const intentionalCloseRef = useRef(false);
  const retryTimeoutRef = useRef<any>(null);
  const retryCountRef = useRef(0);
  const mountedRef = useRef(true);
  const computerRef = useRef<Computer | null>(null);
  const prevRunningRef = useRef(false);
  const currentComputerIdRef = useRef('');

  // Load status from HOB server
  const loadStatus = useCallback(async (silent = false) => {
    try {
      if (!silent) setError('');
      const data = await apiFetch<AgentComputerStatus>(`/api/hermes/agent-computer/status?profile=${encodeURIComponent(profile)}`);
      if (!mountedRef.current) return;
      setStatus(data);
      if (data.error && (!data.computers || data.computers.length === 0) && !data.computer) {
        setError(data.error);
      } else {
        setError('');
      }
      if (data.computer?.id && !selectedCompId) {
        setSelectedCompId(data.computer.id);
      }
      return data;
    } catch (err) {
      if (!mountedRef.current) return;
      if (!silent) setError(errorText(err));
      return null;
    }
  }, [profile, selectedCompId]);

  useEffect(() => {
    mountedRef.current = true;
    void loadStatus();
    const interval = setInterval(() => {
      void loadStatus(true);
    }, 4000);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [loadStatus]);

  const activeComputer = status?.computers?.find(c => c.id === selectedCompId) || status?.computer || null;
  computerRef.current = activeComputer;
  const isRunning = activeComputer?.state === 'ready';

  // Active streaming pump: requests 150ms incremental updates so live desktop never freezes
  useEffect(() => {
    const triggerUpdate = () => {
      const activeRfb = rfbRef.current;
      if (
        activeRfb &&
        isConnectedRef.current &&
        activeRfb._sock &&
        activeRfb._rfbConnectionState === 'connected' &&
        activeRfb._fbWidth > 0 &&
        activeRfb._fbHeight > 0
      ) {
        try {
          const RFBConstructor = resolveRFB(RFB);
          if (RFBConstructor?.messages?.fbUpdateRequest) {
            RFBConstructor.messages.fbUpdateRequest(
              activeRfb._sock,
              true, // incremental
              0,
              0,
              activeRfb._fbWidth,
              activeRfb._fbHeight
            );
          }
        } catch {
          // transient socket flush
        }
      }
    };

    const pumpInterval = setInterval(triggerUpdate, 150);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') triggerUpdate();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);

    return () => {
      clearInterval(pumpInterval);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
    };
  }, []);  // Connect to noVNC stream
  const connect = useCallback((force = false) => {
    const comp = computerRef.current;
    if (!screenRef.current || !comp || comp.state !== 'ready') return;
    if (!force && (isConnectedRef.current || isConnectingRef.current) && rfbRef.current) {
      return;
    }

    clearTimeout(retryTimeoutRef.current);
    retryTimeoutRef.current = null;

    if (rfbRef.current) {
      intentionalCloseRef.current = true;
      try { rfbRef.current.disconnect(); } catch {}
      rfbRef.current = null;
    }

    if (screenRef.current) {
      screenRef.current.innerHTML = '';
    }

    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${scheme}//${window.location.host}/api/hermes/agent-computer/vnc?profile=${encodeURIComponent(profile)}&computerId=${encodeURIComponent(comp.id)}`;

    intentionalCloseRef.current = false;
    isConnectingRef.current = true;
    isConnectedRef.current = false;
    setConnState('connecting');

    try {
      const RFBConstructor = resolveRFB(RFB);
      const rfb = new RFBConstructor(screenRef.current, wsUrl, {
        wsProtocols: ['binary'],
      });
      rfb.scaleViewport = true;
      rfb.background = '#000000';

      // Override encodings to fix the frozen view:
      // 1. Omit continuous updates (-313) which desyncs with TigerVNC
      // 2. Omit cursor (-239) so Xvnc renders the shared mouse cursor directly into framebuffer
      rfb._sendEncodings = function () {
        const encs: number[] = [];
        encs.push(1); // CopyRect
        if (this._fbDepth === 24) {
          encs.push(7);    // Tight
          encs.push(-260); // TightPNG
          encs.push(16);   // ZRLE
          encs.push(21);   // JPEG
          encs.push(5);    // Hextile
          encs.push(2);    // RRE
        }
        encs.push(0); // Raw

        // Pseudo-encodings
        encs.push(-32 + this._qualityLevel);
        encs.push(-256 + this._compressionLevel);
        encs.push(-223); // DesktopSize
        encs.push(-224); // LastRect
        encs.push(-258); // QEMUExtendedKeyEvent
        encs.push(-261); // QEMULedEvent
        encs.push(-308); // ExtendedDesktopSize
        encs.push(-309); // Xvp
        encs.push(-312); // Fence
        encs.push(-307); // DesktopName
        encs.push(0xc0a1e5ce); // ExtendedClipboard

        RFBConstructor.messages.clientEncodings(this._sock, encs);
      };

      rfb.addEventListener('connect', () => {
        isConnectingRef.current = false;
        isConnectedRef.current = true;
        setConnState('connected');
        setError('');
        retryCountRef.current = 0;
      });

      rfb.addEventListener('disconnect', (e: any) => {
        rfbRef.current = null;
        isConnectingRef.current = false;
        isConnectedRef.current = false;

        if (intentionalCloseRef.current) {
          intentionalCloseRef.current = false;
          setConnState('idle');
          return;
        }

        const currComp = computerRef.current;
        const stillRunning = currComp && currComp.state === 'ready';

        if (stillRunning) {
          retryCountRef.current += 1;
          setConnState('connecting');
          const delay = Math.min(500 * Math.pow(1.5, Math.min(retryCountRef.current - 1, 4)), 2000);
          clearTimeout(retryTimeoutRef.current);
          retryTimeoutRef.current = setTimeout(() => {
            connect(true);
          }, delay);
        } else {
          setConnState(e.detail?.clean ? 'disconnected' : 'failed');
        }
      });

      rfbRef.current = rfb;
    } catch (err: any) {
      isConnectingRef.current = false;
      isConnectedRef.current = false;
      setConnState('failed');
      setError(err?.message || 'Failed to initialize RFB viewer');
    }
  }, [profile]);

  // Trigger connect / disconnect based on running state and computerId transitions
  useEffect(() => {
    if (!activeComputer) return;
    const running = activeComputer.state === 'ready';
    const compId = activeComputer.id;

    if (running) {
      const compChanged = currentComputerIdRef.current !== compId;
      if (!prevRunningRef.current || compChanged || (!isConnectedRef.current && !isConnectingRef.current && !rfbRef.current)) {
        prevRunningRef.current = true;
        currentComputerIdRef.current = compId;
        connect();
      }
    } else {
      prevRunningRef.current = false;
      if (rfbRef.current) {
        intentionalCloseRef.current = true;
        try { rfbRef.current.disconnect(); } catch {}
        rfbRef.current = null;
      }
      isConnectedRef.current = false;
      isConnectingRef.current = false;
      setConnState('idle');
    }
  }, [activeComputer?.state, activeComputer?.id, connect]);

  // Teardown RFB strictly on unmount
  useEffect(() => () => {
    intentionalCloseRef.current = true;
    clearTimeout(retryTimeoutRef.current);
    retryTimeoutRef.current = null;
    isConnectingRef.current = false;
    isConnectedRef.current = false;
    if (rfbRef.current) {
      try { rfbRef.current.disconnect(); } catch {}
      rfbRef.current = null;
    }
  }, []);

  // Actions: Wake & Sleep
  const handleWake = async () => {
    if (!activeComputer) return;
    setBusy('wake');
    setError('');
    try {
      await apiFetch(`/api/hermes/agent-computer/wake?profile=${encodeURIComponent(profile)}`, {
        method: 'POST',
        body: JSON.stringify({ computerId: activeComputer.id }),
      });
      await loadStatus();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  };

  const handleSleep = async () => {
    if (!activeComputer) return;
    setBusy('sleep');
    setError('');
    try {
      if (rfbRef.current) {
        intentionalCloseRef.current = true;
        try { rfbRef.current.disconnect(); } catch {}
      }
      await apiFetch(`/api/hermes/agent-computer/sleep?profile=${encodeURIComponent(profile)}`, {
        method: 'POST',
        body: JSON.stringify({ computerId: activeComputer.id }),
      });
      await loadStatus();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  };

  // If MCP server is not connected, render nothing so HOB right panel remains clean
  if (!status || !status.connected) {
    return null;
  }

  const isWaking = busy === 'wake' || activeComputer?.state === 'starting';
  const isSleeping = busy === 'sleep';
  const displayState = isWaking ? 'Starting...' : isSleeping ? 'Sleeping...' : activeComputer?.state || 'Unknown';

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
            onClick={() => void loadStatus()}
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
              className="w-full h-full cursor-default select-none overflow-hidden"
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
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              <span>Live stream</span>
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
                {isWaking ? 'Waking agent computer...' : 'Agent Computer is Sleeping'}
              </p>
              <p className="text-[11px] text-gray-400 leading-relaxed">
                {isWaking
                  ? 'Booting guest desktop and starting agent services...'
                  : 'Screen stream paused to save resources. Wake it anytime to watch live or take control.'}
              </p>
            </div>
            {!isWaking && (
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

export type ComputerConnectionState = 'idle' | 'connecting' | 'connected' | 'failed' | 'disconnected';
export interface ComputerRfb {
  disconnect(): void;
  addEventListener(name: string, listener: (event: Event) => void): void;
  scaleViewport: boolean; clipViewport: boolean; background: string; qualityLevel: number; compressionLevel: number;
  _sock: unknown; _rfbConnectionState: string; _fbWidth: number; _fbHeight: number; _fbDepth: number;
  _qualityLevel: number; _compressionLevel: number; _sendEncodings: () => void;
}
export interface ComputerRfbConstructor {
  new (element: HTMLElement, url: string, options: { wsProtocols: string[] }): ComputerRfb;
  messages: { clientEncodings(socket: unknown, encodings: number[]): void; fbUpdateRequest(socket: unknown, incremental: boolean, x: number, y: number, width: number, height: number): void };
}
export function resolveRfbConstructor(raw: unknown): ComputerRfbConstructor {
  for (let depth = 0; depth < 8; depth++) {
    if (typeof raw === 'function') return raw as ComputerRfbConstructor;
    if (!raw || typeof raw !== 'object' || !('default' in raw)) break;
    raw = (raw as { default: unknown }).default;
  }
  throw new Error('The computer viewer could not be loaded.');
}

/** One stream owner. Late callbacks from replaced sockets cannot clear newer ones. */
export function createComputerStream({ create, directUrl, proxyUrl, onState, onError,
  schedule = (callback: () => void, delay: number) => setTimeout(callback, delay), cancel = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
}: { create: (url: string) => ComputerRfb; directUrl: string; proxyUrl: string; onState: (state: ComputerConnectionState) => void; onError: (message: string) => void;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>; cancel?: (timer: ReturnType<typeof setTimeout>) => void }) {
  let current: ComputerRfb | null = null, closed = false, proxy = !directUrl, attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopTimer = () => { if (timer !== undefined) cancel(timer); timer = undefined; };
  const retire = () => { const old = current; current = null; try { old?.disconnect(); } catch { /* Already closed. */ } };
  const retry = () => {
    if (closed) return;
    if (!proxy) { proxy = true; timer = schedule(connect, 0); return; }
    if (++attempts > 6) { onState('failed'); onError('The live desktop disconnected. Refresh to reconnect.'); return; }
    onState('connecting'); timer = schedule(connect, Math.min(500 * 1.5 ** (attempts - 1), 2000));
  };
  function connect() {
    if (closed) return;
    stopTimer(); retire(); onState('connecting');
    try {
      const client = create(proxy ? proxyUrl : directUrl);
      current = client;
      client.addEventListener('connect', () => { if (!closed && current === client) { attempts = 0; onState('connected'); onError(''); } });
      client.addEventListener('disconnect', () => { if (!closed && current === client) { current = null; retry(); } });
    } catch { retire(); retry(); }
  }
  return {
    connect,
    reconnect() { attempts = 0; connect(); },
    requestUpdate(send: (client: ComputerRfb) => void) {
      if (!closed && current?._rfbConnectionState === 'connected' && current._fbWidth > 0 && current._fbHeight > 0) {
        try { send(current); } catch { /* A disconnect can race an update request. */ }
      }
    },
    close() { if (closed) return; closed = true; stopTimer(); retire(); },
  };
}

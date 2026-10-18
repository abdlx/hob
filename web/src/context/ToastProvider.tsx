import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { ToastContext } from './ToastContext';
import type { ToastTone } from './ToastContext';

interface ToastItem { id: number; message: string; tone: ToastTone }

const toneStyles: Record<ToastTone, { className: string; icon: ReactNode }> = {
  success: { className: 'border-ok-soft bg-ok-soft text-ok', icon: <CheckCircle2 size={15} /> },
  error: { className: 'border-red-200 bg-red-50 text-red-700', icon: <AlertTriangle size={15} /> },
  info: { className: 'border-hair bg-surface text-ink', icon: <Info size={15} /> },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((item) => item.id !== id)), []);
  const toast = useCallback((message: string, tone: ToastTone = 'success') => {
    const id = ++nextId.current;
    setToasts((list) => [...list, { id, message, tone }]);
    window.setTimeout(() => setToasts((list) => list.filter((item) => item.id !== id)), 4200);
  }, []);
  const value = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[100] flex flex-col items-center gap-2 px-4">
        {toasts.map((item) => {
          const style = toneStyles[item.tone];
          return (
            <div
              key={item.id}
              role="status"
              aria-live="polite"
              className={`pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl border px-3.5 py-3 text-xs md:text-sm shadow-lg ${style.className}`}
            >
              <span className="mt-0.5 shrink-0">{style.icon}</span>
              <span className="flex-1 leading-relaxed">{item.message}</span>
              <button type="button" onClick={() => dismiss(item.id)} aria-label="Dismiss notification" className="shrink-0 rounded-md p-0.5 opacity-60 transition-opacity hover:opacity-100">
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

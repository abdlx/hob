import { useState } from 'react';
import type { ReactNode } from 'react';

export const inputClass = 'w-full rounded-xl border border-edge bg-surface px-3.5 py-2.5 text-sm text-ink placeholder-faint outline-none transition-colors focus:border-accent focus:ring-0 disabled:opacity-50';
export const buttonClass = 'inline-flex items-center justify-center gap-1.5 rounded-xl border border-edge bg-surface px-3.5 py-2 text-xs md:text-sm font-medium text-ink hover:bg-sunken hover:border-edge-strong transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer active:scale-[0.98] shadow-xs';
export const cardClass = 'rounded-2xl border border-hair bg-surface p-4 md:p-5 shadow-xs';
export const dangerButtonClass = 'inline-flex items-center justify-center gap-1.5 rounded-xl border border-red-200 bg-bad px-3.5 py-2 text-xs md:text-sm font-medium text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer active:scale-[0.98] shadow-xs';
export const sectionLabelClass = 'text-[12px] font-medium text-muted px-1';

export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div
      role={error ? 'alert' : 'status'}
      className={`rounded-xl border p-3.5 text-xs md:text-sm leading-relaxed ${
        error
          ? 'border-red-200 text-red-700 bg-red-50'
          : 'border-hair text-muted bg-panel'
      }`}
    >
      {children}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs md:text-sm font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="block text-xs leading-relaxed text-muted">{hint}</span>}
    </label>
  );
}

type StatusTone = { label: string; pill: string; dot: string };

const statusTones: Record<string, StatusTone> = {
  in_progress: { label: 'Running', pill: 'bg-run-soft text-run', dot: 'bg-amber-400' },
  running: { label: 'Running', pill: 'bg-run-soft text-run', dot: 'bg-amber-400' },
  review: { label: 'Pending review', pill: 'bg-run-soft text-run', dot: 'bg-amber-400' },
  completed: { label: 'Done', pill: 'bg-ok-soft text-ok', dot: 'bg-ok-dot' },
  done: { label: 'Done', pill: 'bg-ok-soft text-ok', dot: 'bg-ok-dot' },
  ok: { label: 'OK', pill: 'bg-ok-soft text-ok', dot: 'bg-ok-dot' },
  applied: { label: 'Applied', pill: 'bg-ok-soft text-ok', dot: 'bg-ok-dot' },
  enabled: { label: 'Enabled', pill: 'bg-ok-soft text-ok', dot: 'bg-ok-dot' },
  active: { label: 'Active', pill: 'bg-ok-soft text-ok', dot: 'bg-ok-dot' },
  connected: { label: 'Connected', pill: 'bg-ok-soft text-ok', dot: 'bg-ok-dot' },
  scheduled: { label: 'Scheduled', pill: 'bg-accent-soft text-accent', dot: 'bg-accent' },
  failed: { label: 'Failed', pill: 'bg-bad-soft text-bad', dot: 'bg-red-500' },
  cancelled: { label: 'Cancelled', pill: 'bg-bad-soft text-bad', dot: 'bg-red-500' },
  error: { label: 'Error', pill: 'bg-bad-soft text-bad', dot: 'bg-red-500' },
  interrupted: { label: 'Interrupted', pill: 'bg-warn-soft text-warn', dot: 'bg-orange-500' },
  pending: { label: 'Queued', pill: 'bg-idle-soft text-soft', dot: 'bg-faint' },
  queued: { label: 'Queued', pill: 'bg-idle-soft text-soft', dot: 'bg-faint' },
  idle: { label: 'Idle', pill: 'bg-idle-soft text-soft', dot: 'bg-faint' },
  paused: { label: 'Paused', pill: 'bg-idle-soft text-soft', dot: 'bg-faint' },
  disabled: { label: 'Disabled', pill: 'bg-idle-soft text-soft', dot: 'bg-faint' },
  rejected: { label: 'Rejected', pill: 'bg-idle-soft text-soft', dot: 'bg-faint' },
};

export function StatusPill({ status, label }: { status?: string | null; label?: string }) {
  const key = (status ?? '').toLowerCase();
  const tone = statusTones[key] ?? {
    label: status ? status.replace(/[_-]+/g, ' ') : 'Unknown',
    pill: 'bg-idle-soft text-soft',
    dot: 'bg-faint',
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${tone.pill}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} />
      {label ?? tone.label}
    </span>
  );
}

export function CardList({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-surface overflow-hidden ${className}`}>{children}</div>;
}

export function CardRow({ children, className = '', onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  const classes = `flex w-full items-start gap-3 px-3 py-2.5 text-left border-b border-line last:border-b-0 ${onClick ? 'hover:bg-black/[0.02] transition-colors cursor-pointer' : ''} ${className}`;
  if (onClick) {
    return <button type="button" onClick={onClick} className={classes}>{children}</button>;
  }
  return <div className={classes}>{children}</div>;
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-hair bg-surface py-12 px-6 text-center shadow-xs">
      {icon && <div className="mb-4 flex justify-center text-accent">{icon}</div>}
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      {description && <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">{description}</p>}
      {action && <div className="mt-5 flex justify-center gap-2">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-lg bg-line ${className}`} />;
}

/**
 * A button that reveals an inline confirmation popover instead of pushing a
 * separate confirm block into the card. Keeps destructive actions in context.
 */
export function ConfirmButton({ onConfirm, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', children, disabled, className, tone = 'default', drop = 'up' }: {
  onConfirm: () => void;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  tone?: 'default' | 'danger';
  drop?: 'up' | 'down';
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button type="button" className={className ?? buttonClass} disabled={disabled} aria-expanded={open} onClick={() => setOpen((value) => !value)}>{children}</button>
      {open && (
        <>
          <span className="fixed inset-0 z-20" aria-hidden onClick={() => setOpen(false)} />
          <span className={`absolute z-30 ${drop === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'} left-1/2 -translate-x-1/2 block w-64 rounded-xl border border-hair bg-surface p-3 text-left text-xs shadow-lg`}>
            <span className="block text-muted leading-relaxed">{message}</span>
            <span className="mt-2.5 flex justify-end gap-2">
              <button type="button" className={buttonClass} onClick={() => setOpen(false)}>{cancelLabel}</button>
              <button type="button" className={tone === 'danger' ? dangerButtonClass : buttonClass} onClick={() => { setOpen(false); onConfirm(); }}>{confirmLabel}</button>
            </span>
          </span>
        </>
      )}
    </span>
  );
}

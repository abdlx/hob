import type { ReactNode } from 'react';

export const inputClass = 'w-full rounded-xl border border-[rgba(25,35,50,0.12)] bg-[#FFFFFF] px-3.5 py-2.5 text-sm text-[#17191D] placeholder-[#8792A1] outline-none transition-colors focus:border-[#1677FF] focus:ring-0 disabled:opacity-50';
export const buttonClass = 'inline-flex items-center justify-center gap-1.5 rounded-xl border border-[rgba(25,35,50,0.1)] bg-[#FFFFFF] px-3.5 py-2 text-xs md:text-sm font-medium text-[#17191D] hover:bg-[#F5F5F5] hover:border-[rgba(25,35,50,0.18)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer active:scale-[0.98] shadow-xs';
export const cardClass = 'rounded-2xl border border-[rgba(25,35,50,0.08)] bg-[#FFFFFF] p-4 md:p-5 shadow-xs';
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div
      role={error ? 'alert' : 'status'}
      className={`rounded-xl border p-3.5 text-xs md:text-sm leading-relaxed ${
        error
          ? 'border-red-200 text-red-700 bg-red-50'
          : 'border-[rgba(25,35,50,0.08)] text-[#687588] bg-[#F5F5F7]'
      }`}
    >
      {children}
    </div>
  );
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs md:text-sm font-medium text-[#17191D]">{label}</span>
      {children}
      {hint && <span className="block text-xs leading-relaxed text-[#687588]">{hint}</span>}
    </label>
  );
}

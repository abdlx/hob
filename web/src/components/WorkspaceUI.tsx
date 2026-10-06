import type { ReactNode } from 'react';

export const inputClass = 'w-full rounded-xl border border-[#292622] bg-[#111111] px-3 py-2 text-[12px] text-[#e5e2dc] outline-none focus:border-[#8a6b46] disabled:opacity-50';
export const buttonClass = 'inline-flex items-center justify-center gap-1.5 rounded-full border border-[#302a23] bg-[#201b15] px-3 py-1.5 text-[11px] text-[#d8c4a8] hover:bg-[#30271d] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer';
export const cardClass = 'rounded-2xl border border-[#24211d] bg-[#0d0d0d] p-4';
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) { return <p role={error ? 'alert' : 'status'} className={`rounded-xl border p-3 text-[11px] leading-relaxed ${error ? 'border-red-900/60 text-red-300 bg-red-950/20' : 'border-[#24211d] text-[#928a7d] bg-[#111]'}`}>{children}</p>; }
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="block space-y-1.5"><span className="block text-[11px] text-[#bdb4a5]">{label}</span>{children}{hint && <span className="block text-[10px] leading-relaxed text-[#746d63]">{hint}</span>}</label>; }

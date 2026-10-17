import type { ReactNode } from 'react';

export const inputClass = 'w-full rounded-xl border border-[#343b45] bg-[#13171d] px-3.5 py-2.5 text-sm text-[#e7ebf0] placeholder-[#7d8793] outline-none transition-colors focus:border-[#4b5563] focus:ring-0 disabled:opacity-50';
export const buttonClass = 'inline-flex items-center justify-center gap-1.5 rounded-xl border border-[#3b444f] bg-[#1b222b] px-3.5 py-2 text-xs md:text-sm font-medium text-[#d8dee6] hover:bg-[#252e38] hover:border-[#56616e] hover:text-[#f2f4f7] transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer active:scale-[0.98]';
export const cardClass = 'rounded-2xl border border-[#303944] bg-[#151b23] p-4 md:p-5';
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) { return <div role={error ? 'alert' : 'status'} className={`rounded-xl border p-3.5 text-xs md:text-sm leading-relaxed ${error ? 'border-red-900/60 text-red-200 bg-red-950/30' : 'border-[#332b22] text-[#b3a696] bg-[#171410]'}`}>{children}</div>; }
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="block space-y-1.5"><span className="block text-xs md:text-sm font-medium text-[#ded4c6]">{label}</span>{children}{hint && <span className="block text-xs leading-relaxed text-[#8f8373]">{hint}</span>}</label>; }

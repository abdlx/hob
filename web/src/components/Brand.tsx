import { HLogo } from './HLogo';

export function Brand({ compact = false, className = '' }: { compact?: boolean; className?: string }) {
  return (
    <span className={`hob-brand inline-flex items-center gap-2 select-none ${className}`} aria-label="hob">
      <HLogo size={compact ? 32 : 28} />
      {!compact && (
        <span className="font-bold text-[22px] tracking-tight text-[#17191D]">
          hob<span className="text-[#1677FF]">.</span>
        </span>
      )}
    </span>
  );
}

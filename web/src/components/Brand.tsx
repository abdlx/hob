export function Brand({ compact = false, className = '' }: { compact?: boolean; className?: string }) {
  return (
    <span className={`hob-brand inline-flex items-center gap-2 select-none ${className}`} aria-label="hob">
      <img
        src="/brand/hob-mark.png"
        alt="hob"
        width={compact ? "36" : "32"}
        height={compact ? "36" : "32"}
        className="object-contain"
      />
      {!compact && (
        <span className="font-bold text-[22px] tracking-tight text-ink">
          hob<span className="text-accent">.</span>
        </span>
      )}
    </span>
  );
}

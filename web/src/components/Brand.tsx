export function Brand({ compact = false, className = '' }: { compact?: boolean; className?: string }) {
  return <span className={`hob-brand ${className}`} aria-label="hob">
    <img src="/brand/hob-mark.png" alt="" width={compact ? "42" : "38"} height={compact ? "42" : "38"} />
    {!compact && <span>hob<span className="hob-brand-dot">.</span></span>}
  </span>;
}

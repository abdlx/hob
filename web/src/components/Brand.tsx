export function Brand({ compact = false, className = '' }: { compact?: boolean; className?: string }) {
  return <span className={`hob-brand ${className}`} aria-label="hob">
    <img src="/brand/hob-mark.png" alt="" width="36" height="36" />
    {!compact && <span>hob<span className="hob-brand-dot">.</span></span>}
  </span>;
}

import type { ReactNode } from "react";

export interface HypoutLogoProps {
  size?: number;
  /** Show the wordmark next to the mark. */
  label?: boolean;
  className?: string;
}

/**
 * The mark is a signal leaving a source: a filled node (the publisher, in the one accent colour) and three arcs
 * that widen and fade as they travel, which is a message fanning out to its subscribers.
 */
export function HypoutLogo({ size = 28, label = true, className }: HypoutLogoProps): ReactNode {
  return (
    <span className={`hy-logo${className ? ` ${className}` : ""}`} style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" role="img" aria-label="Hypout">
        <rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="var(--hy-bg, #0a0a0b)" stroke="var(--hy-ink, #fafafa)" strokeOpacity="0.35" strokeWidth="1.5" />
        <path d="M13.2 11.2a6 6 0 0 1 0 9.6" stroke="var(--hy-ink, #fafafa)" strokeWidth="2" strokeLinecap="round" />
        <path d="M16.6 7.9a10.6 10.6 0 0 1 0 16.2" stroke="var(--hy-ink, #fafafa)" strokeWidth="2" strokeLinecap="round" strokeOpacity="0.7" />
        <path d="M20.3 5.8a14.4 14.4 0 0 1 0 20.4" stroke="var(--hy-ink, #fafafa)" strokeWidth="2" strokeLinecap="round" strokeOpacity="0.4" />
        <circle cx="9" cy="16" r="2.6" fill="var(--hy-live, #f59e0b)" />
      </svg>
      {label ? <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em", color: "var(--hy-ink, #fafafa)" }}>Hypout</span> : null}
    </span>
  );
}

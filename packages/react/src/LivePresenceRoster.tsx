import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Json } from "@hypout/core/protocol";
import { useConnectionStatus, usePresence } from "./hooks";

export interface LivePresenceRosterProps {
  channel: string;
  /** Announce this client on the channel with this state (for example `{ name: "Ada", status: "typing" }`). */
  state?: Record<string, Json>;
  /** Show at most this many avatars before collapsing the rest into "+N". Default 8. */
  maxVisible?: number;
  title?: string;
  className?: string;
}

const label = (state: Record<string, Json>, key: string): string => {
  const n = state["name"] ?? state["username"] ?? state["userId"];
  return typeof n === "string" && n ? n : key;
};
const initials = (name: string): string => {
  const parts = name.replace(/^anon:/, "").split(/[\s_.-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase();
};

/** Who is on a channel right now, kept live by CRDT presence operations. Joins and leaves are announced politely to screen readers. */
export function LivePresenceRoster({ channel, state, maxVisible = 8, title = "Online now", className }: LivePresenceRosterProps): ReactNode {
  const { members, self } = usePresence(channel, state);
  const status = useConnectionStatus();
  const [announce, setAnnounce] = useState("");
  const known = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const next = new Map(members.map((m) => [m.key, label(m.state, m.key)]));
    const prev = known.current;
    if (prev.size > 0 || next.size > 0) {
      const joined = [...next].filter(([k]) => !prev.has(k)).map(([, n]) => n);
      const left = [...prev].filter(([k]) => !next.has(k)).map(([, n]) => n);
      if (prev.size > 0 && (joined.length || left.length)) setAnnounce([...joined.map((n) => `${n} joined`), ...left.map((n) => `${n} left`)].join(". "));
    }
    known.current = next;
  }, [members]);

  const shown = members.slice(0, maxVisible);
  const hidden = members.length - shown.length;
  return (
    <section className={`hy-card hy-roster${className ? ` ${className}` : ""}`} aria-label={title}>
      <header className="hy-card-head">
        <h3 className="hy-h">{title}</h3>
        <span className="hy-count" aria-label={`${members.length} online`}>
          <span className={`hy-dot hy-dot-${status === "open" ? "ok" : "off"}`} aria-hidden="true" />
          {members.length}
        </span>
      </header>
      {members.length === 0 ? (
        <p className="hy-empty">{status === "open" ? "Nobody here yet." : "Connecting…"}</p>
      ) : (
        <ul className="hy-list" role="list">
          {shown.map((m) => {
            const name = label(m.state, m.key);
            const you = self?.key === m.key;
            const detail = typeof m.state["status"] === "string" ? m.state["status"] : null;
            return (
              <li key={m.key} className="hy-person">
                <span className="hy-avatar" aria-hidden="true">
                  {initials(name)}
                </span>
                <span className="hy-person-text">
                  <span className="hy-person-name">
                    {name}
                    {you ? <span className="hy-you"> (you)</span> : null}
                  </span>
                  {detail ? <span className="hy-person-detail">{detail}</span> : null}
                </span>
              </li>
            );
          })}
          {hidden > 0 ? <li className="hy-more">+{hidden} more</li> : null}
        </ul>
      )}
      <p className="hy-sr" role="status" aria-live="polite">
        {announce}
      </p>
    </section>
  );
}

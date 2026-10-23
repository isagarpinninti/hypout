"use client";

import { useEffect, useState, type ReactNode } from "react";
import { adminFetch } from "@hypout/react";
import type { Connection } from "../lib/connection";

interface Check {
  code: string;
  name: string;
  ok: boolean;
  skipped: boolean;
  message: string;
}

/** Runs the HP-101 to HP-106 gates against the message being typed, without sending it. */
export function PreflightPanel({ conn, channel, event, data, anonymous }: { conn: Connection; channel: string; event: string; data: unknown; anonymous: boolean }): ReactNode {
  const [checks, setChecks] = useState<Check[]>([]);
  const [error, setError] = useState("");
  const dataKey = JSON.stringify(data) ?? "null";

  useEffect(() => {
    const ctl = new AbortController();
    const id = setTimeout(() => {
      adminFetch<{ checks: Check[] }>(conn, "/api/preflight", { method: "POST", body: { op: "pub", channel, event, data: JSON.parse(dataKey) as unknown, anonymous }, signal: ctl.signal }).then(
        (r) => {
          setChecks(r.checks);
          setError("");
        },
        (e: unknown) => {
          if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "request failed");
        },
      );
    }, 250);
    return () => {
      clearTimeout(id);
      ctl.abort();
    };
  }, [conn, channel, event, dataKey, anonymous]);

  return (
    <section aria-label="Gate pre-flight" className="hy-card">
      <header className="hy-card-head">
        <h3 className="hy-h">Gates</h3>
        <span className="hy-muted">{anonymous ? "as an anonymous client" : "as an admin"}</span>
      </header>
      {error ? (
        <p role="alert" className="hy-error">
          {error}
        </p>
      ) : (
        <ul className="grid gap-1.5" role="list">
          {checks.map((c) => (
            <li key={c.code} className="grid grid-cols-[4.5rem_1fr] gap-2">
              <span className="font-mono text-[12px] text-muted">{c.code}</span>
              <span>
                <span className={c.skipped ? "text-faint" : c.ok ? "text-ok" : "text-danger"}>
                  <span aria-hidden="true">{c.skipped ? "–" : c.ok ? "✓" : "✕"}</span>
                  <span className="sr-only">{c.skipped ? "skipped" : c.ok ? "passes" : "fails"}</span> {c.name}
                </span>
                {!c.ok || c.skipped ? <span className="block text-xs text-muted">{c.message}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

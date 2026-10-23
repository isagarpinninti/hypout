"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { usePolled, type ChannelsResponse } from "@hypout/react";
import type { Connection } from "../lib/connection";

const NAME = /^[a-z][a-z0-9_-]{0,31}(:[A-Za-z0-9_.:=@-]{1,64})?$/;

export function ChannelList({ conn, selected, onSelect }: { conn: Connection; selected: string | null; onSelect(name: string): void }): ReactNode {
  const { data, error } = usePolled<ChannelsResponse>(conn, "/api/channels", 2000);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState("");
  const live = new Set((data?.channels ?? []).map((c) => c.name));

  const open = (e: FormEvent): void => {
    e.preventDefault();
    const name = draft.trim();
    if (!NAME.test(name)) return setProblem("Use namespace or namespace:id, like chat:lobby");
    const ns = name.split(":", 1)[0];
    if (data && !data.namespaces.some((n) => n.namespace === ns)) return setProblem(`No namespace "${ns}" is defined (HP-101)`);
    setProblem("");
    setDraft("");
    onSelect(name);
  };

  return (
    <nav aria-label="Channels" className="grid content-start gap-4">
      <form onSubmit={open} className="grid gap-1.5">
        <label htmlFor="open-channel" className="text-muted">
          Open a channel
        </label>
        <div className="flex gap-2">
          <input id="open-channel" className="hy-input min-w-0 flex-1" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="chat:lobby" autoComplete="off" spellCheck={false} aria-describedby={problem ? "open-problem" : undefined} aria-invalid={problem ? true : undefined} />
          <button type="submit" className="hy-btn">
            Open
          </button>
        </div>
        {problem ? (
          <p id="open-problem" role="alert" className="text-danger">
            {problem}
          </p>
        ) : null}
      </form>
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
      {(data?.namespaces ?? []).map((ns) => {
        const channels = (data?.channels ?? []).filter((c) => c.name.split(":", 1)[0] === ns.namespace);
        const items = channels.some((c) => c.name === ns.namespace) ? channels : [{ name: ns.namespace, subscribers: 0, head: 0, retained: 0, members: 0 }, ...channels];
        return (
          <section key={ns.namespace} aria-label={`Namespace ${ns.namespace}`}>
            <h2 className="mb-1 flex items-baseline justify-between text-[11px] font-semibold uppercase tracking-wider text-faint">
              <span>{ns.namespace}</span>
              <span className="font-normal normal-case tracking-normal">{Object.keys(ns.events).length || "any"} events</span>
            </h2>
            <ul className="grid gap-0.5">
              {items.map((c) => (
                <li key={c.name}>
                  <button
                    type="button"
                    onClick={() => onSelect(c.name)}
                    aria-current={selected === c.name ? "true" : undefined}
                    className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-raised ${selected === c.name ? "bg-raised font-medium" : "text-muted"}`}
                  >
                    <span className="min-w-0 truncate font-mono text-[13px]">{c.name}</span>
                    <span className="shrink-0 text-xs text-faint">{live.has(c.name) ? `${c.subscribers} · #${c.head}` : "idle"}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {data && data.namespaces.length === 0 ? <p className="text-muted">No namespaces yet. Run <code>hypout init</code> and restart.</p> : null}
    </nav>
  );
}

"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { HypoutError, useChannel, useConnectionStatus } from "@hypout/react";
import type { Json } from "@hypout/core/protocol";
import type { Connection } from "../lib/connection";
import { PreflightPanel } from "./PreflightPanel";

const time = (ts: number): string => new Date(ts).toISOString().slice(11, 23);

export function FeedPanel({ conn, channel }: { conn: Connection; channel: string }): ReactNode {
  const { events, head, subscribed, gap, error, publish } = useChannel(channel, { limit: 200 });
  const status = useConnectionStatus();
  const [event, setEvent] = useState("message");
  const [body, setBody] = useState('{ "text": "hello from the Studio" }');
  const [anon, setAnon] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  let parsed: Json | undefined;
  let parseError = "";
  try {
    parsed = JSON.parse(body) as Json;
  } catch (e) {
    parseError = e instanceof Error ? e.message : "invalid JSON";
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [events.length]);

  const send = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (parsed === undefined) return;
    try {
      const r = await publish(event, parsed);
      setResult({ ok: true, text: `Published as #${r.seq}` });
    } catch (err) {
      setResult({ ok: false, text: err instanceof HypoutError ? `${err.code} ${err.message}` : err instanceof Error ? err.message : "failed" });
    }
  };

  return (
    <div className="grid gap-4">
      <section className="hy-card" aria-label={`Live events on ${channel}`}>
        <header className="hy-card-head">
          <h2 className="hy-h font-mono">{channel}</h2>
          <span className="hy-muted">
            {status !== "open" ? status : subscribed ? `head #${head}` : "subscribing…"}
            {gap ? " · replay gap" : ""}
          </span>
        </header>
        {error ? (
          <p role="alert" className="hy-error">
            {error.code} {error.message}
          </p>
        ) : null}
        <div className="hy-scroll min-h-40 max-h-[360px]" tabIndex={0} role="log" aria-live="off" aria-label="Events">
          {events.length === 0 ? (
            <p className="hy-empty p-3">No events yet. Publish one below, or from <code>hypout publish</code>.</p>
          ) : (
            <ol className="m-0 grid list-none gap-0 p-0">
              {events.map((ev) => (
                <li key={ev.seq} className="grid grid-cols-[3.2rem_1fr] gap-x-3 border-b border-line px-3 py-1.5 last:border-b-0">
                  <span className="font-mono text-xs text-faint">#{ev.seq}</span>
                  <span className="min-w-0">
                    <span className="font-medium">{ev.ev}</span> <span className="text-xs text-muted">{time(ev.ts)} · {ev.from}{ev.replay ? " · replay" : ""}</span>
                    <code className="block overflow-x-auto whitespace-pre-wrap break-words text-[12.5px] text-muted">{JSON.stringify(ev.data)}</code>
                  </span>
                </li>
              ))}
            </ol>
          )}
          <div ref={endRef} />
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <form onSubmit={(e) => void send(e)} className="hy-card grid gap-3" aria-label="Publish an event">
          <h3 className="hy-h">Publish</h3>
          <label className="grid gap-1">
            <span className="text-muted">Event</span>
            <input className="hy-input" value={event} onChange={(e) => setEvent(e.target.value)} spellCheck={false} />
          </label>
          <label className="grid gap-1">
            <span className="text-muted">Data (JSON)</span>
            <textarea className="hy-input min-h-24 font-mono" value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} aria-invalid={parseError ? true : undefined} aria-describedby={parseError ? "json-problem" : undefined} />
          </label>
          {parseError ? (
            <p id="json-problem" className="hy-error">
              {parseError}
            </p>
          ) : null}
          <label className="flex items-center gap-2 text-muted">
            <input type="checkbox" checked={anon} onChange={(e) => setAnon(e.target.checked)} />
            Check the gates as an anonymous client
          </label>
          <div className="flex items-center gap-3">
            <button type="submit" className="hy-btn hy-btn-primary" disabled={parsed === undefined || !event.trim() || status !== "open"}>
              Publish
            </button>
            <p role="status" className={result?.ok ? "text-ok" : "hy-error"}>
              {result?.text}
            </p>
          </div>
        </form>
        <PreflightPanel conn={conn} channel={channel} event={event} data={parsed ?? null} anonymous={anon} />
      </div>
    </div>
  );
}

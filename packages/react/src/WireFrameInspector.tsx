import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { explainHeader } from "@hypout/core/protocol";
import { adminFetch, type AdminConnection } from "./admin";
import type { WireEntry } from "./types";

export interface WireFrameInspectorProps extends AdminConnection {
  pollMs?: number;
  /** How many frames to keep in the list. Default 300. */
  keep?: number;
  className?: string;
}

const fromHex = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
const clock = (ts: number): string => new Date(ts).toISOString().slice(11, 23);

/** Every WebSocket frame that crossed the server, newest last, with the header decoded field by field in the browser. */
export function WireFrameInspector({ baseUrl, token, pollMs = 1000, keep = 300, className }: WireFrameInspectorProps): ReactNode {
  const [frames, setFrames] = useState<WireEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [dir, setDir] = useState<"all" | "in" | "out">("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const since = useRef(0);

  useEffect(() => {
    if (paused) return;
    const ctl = new AbortController();
    const load = async (): Promise<void> => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const r = await adminFetch<{ head: number; frames: WireEntry[] }>({ baseUrl, token }, `/api/wire?since=${since.current}`, { signal: ctl.signal });
        setError(null);
        if (r.head < since.current) since.current = 0;
        if (r.frames.length > 0) {
          since.current = r.head;
          setFrames((prev) => [...prev, ...r.frames].slice(-keep));
        }
      } catch (e) {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "request failed");
      }
    };
    void load();
    const id = setInterval(() => void load(), pollMs);
    return () => {
      ctl.abort();
      clearInterval(id);
    };
  }, [baseUrl, token, pollMs, paused, keep]);

  const clear = useCallback(() => {
    setFrames([]);
    setSelected(null);
    void adminFetch({ baseUrl, token }, "/api/wire", { method: "DELETE" }).catch(() => undefined);
  }, [baseUrl, token]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return frames.filter((f) => (dir === "all" || f.dir === dir) && (!q || f.name.toLowerCase().includes(q) || f.cid.includes(q) || (f.text ?? "").toLowerCase().includes(q)));
  }, [frames, dir, query]);
  const sel = frames.find((f) => f.id === selected) ?? null;
  const fields = useMemo(() => {
    if (!sel) return [];
    try {
      return explainHeader(fromHex(sel.raw));
    } catch {
      return [];
    }
  }, [sel]);

  return (
    <section className={`hy-card hy-wire${className ? ` ${className}` : ""}`} aria-label="Wire frame inspector">
      <header className="hy-card-head">
        <h3 className="hy-h">Wire frames</h3>
        <div className="hy-toolbar">
          <label className="hy-sr" htmlFor="hy-wire-q">
            Filter frames
          </label>
          <input id="hy-wire-q" className="hy-input" type="search" placeholder="Filter…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <label className="hy-sr" htmlFor="hy-wire-dir">
            Direction
          </label>
          <select id="hy-wire-dir" className="hy-input" value={dir} onChange={(e) => setDir(e.target.value as "all" | "in" | "out")}>
            <option value="all">Both ways</option>
            <option value="in">Client → server</option>
            <option value="out">Server → client</option>
          </select>
          <button type="button" className="hy-btn" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
            {paused ? "Resume" : "Pause"}
          </button>
          <button type="button" className="hy-btn" onClick={clear}>
            Clear
          </button>
        </div>
      </header>
      {error ? (
        <p className="hy-error" role="alert">
          Cannot read the wire: {error}
        </p>
      ) : null}
      <div className="hy-wire-body">
        <div className="hy-scroll" tabIndex={0} role="region" aria-label="Frame list">
          <table className="hy-table hy-table-dense">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Dir</th>
                <th scope="col">Conn</th>
                <th scope="col">Opcode</th>
                <th scope="col">Len</th>
                <th scope="col">Payload</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={6} className="hy-empty">
                    {frames.length === 0 ? "No frames yet. Connect a client." : "No frames match."}
                  </td>
                </tr>
              ) : (
                visible.map((f) => (
                  <tr key={f.id} className={`${selected === f.id ? "hy-selected" : ""}${f.dropped ? " hy-dropped" : ""}`}>
                    <td className="hy-mono">{clock(f.ts)}</td>
                    <td>
                      <span aria-label={f.dir === "in" ? "client to server" : "server to client"}>{f.dir === "in" ? "→" : "←"}</span>
                    </td>
                    <td className="hy-mono">{f.cid.slice(2, 8)}</td>
                    <td>
                      <button type="button" className="hy-link" onClick={() => setSelected(f.id)} aria-pressed={selected === f.id}>
                        {f.name}
                      </button>
                      {f.dropped ? <span className="hy-badge hy-badge-warn"> dropped</span> : null}
                    </td>
                    <td className="hy-mono">{f.length}</td>
                    <td className="hy-mono hy-clip">{f.text ?? ""}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <aside className="hy-detail" aria-label="Frame detail" aria-live="polite">
          {sel ? (
            <>
              <h4 className="hy-h">
                {sel.name} · {sel.length} bytes · {sel.dir === "in" ? "masked by client" : "unmasked by server"}
              </h4>
              <dl className="hy-fields">
                {fields.map((f) => (
                  <div key={f.name} className="hy-field">
                    <dt>{f.name}</dt>
                    <dd>
                      <code>{f.bits}</code> {f.value}
                      {f.note ? <span className="hy-muted"> {f.note}</span> : null}
                    </dd>
                  </div>
                ))}
              </dl>
              <pre className="hy-hex" tabIndex={0}>
                {sel.hex}
              </pre>
            </>
          ) : (
            <p className="hy-empty">Select a frame to decode its header.</p>
          )}
        </aside>
      </div>
    </section>
  );
}

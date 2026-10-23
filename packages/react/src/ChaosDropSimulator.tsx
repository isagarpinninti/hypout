import { useEffect, useState, type ReactNode } from "react";
import { adminFetch, usePolled, type AdminConnection } from "./admin";
import type { ChaosState } from "./types";

export interface ChaosDropSimulatorProps extends AdminConnection {
  pollMs?: number;
  className?: string;
}

const PRESETS: Array<{ name: string; dropRate: number; delayMs: number; jitterMs: number }> = [
  { name: "Clean", dropRate: 0, delayMs: 0, jitterMs: 0 },
  { name: "Weak Wi-Fi", dropRate: 0.15, delayMs: 60, jitterMs: 120 },
  { name: "Tunnel", dropRate: 0.5, delayMs: 300, jitterMs: 400 },
];

/**
 * Makes the server's network lossy on purpose: a share of event and presence frames is silently dropped or delayed.
 * Clients notice the hole in the sequence and ask for a replay, which is the thing to watch in the wire inspector.
 */
export function ChaosDropSimulator({ baseUrl, token, pollMs = 1500, className }: ChaosDropSimulatorProps): ReactNode {
  const conn = { baseUrl, token };
  const { data, error } = usePolled<ChaosState>(conn, "/api/chaos", pollMs);
  const [drop, setDrop] = useState(0);
  const [delay, setDelay] = useState(0);
  const [jitter, setJitter] = useState(0);
  const [note, setNote] = useState("");
  const [fail, setFail] = useState<string | null>(null);
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (data && !seeded) {
      setDrop(Math.round(data.dropRate * 100));
      setDelay(data.delayMs);
      setJitter(data.jitterMs);
      setSeeded(true);
    }
  }, [data, seeded]);

  const apply = async (d: number, l: number, j: number): Promise<void> => {
    try {
      const r = await adminFetch<ChaosState>(conn, "/api/chaos", { method: "POST", body: { dropRate: d / 100, delayMs: l, jitterMs: j } });
      setFail(null);
      setNote(r.active ? `Chaos on: dropping ${Math.round(r.dropRate * 100)}% of events, delaying ${r.delayMs}–${r.delayMs + r.jitterMs} ms.` : "Chaos off: the network is clean.");
    } catch (e) {
      setFail(e instanceof Error ? e.message : "request failed");
    }
  };

  const preset = (p: (typeof PRESETS)[number]): void => {
    const d = Math.round(p.dropRate * 100);
    setDrop(d);
    setDelay(p.delayMs);
    setJitter(p.jitterMs);
    void apply(d, p.delayMs, p.jitterMs);
  };

  return (
    <section className={`hy-card hy-chaos${className ? ` ${className}` : ""}`} aria-label="Chaos drop simulator">
      <header className="hy-card-head">
        <h3 className="hy-h">Chaos</h3>
        <span className={`hy-badge${data?.active ? " hy-badge-warn" : ""}`}>{data?.active ? "active" : "off"}</span>
      </header>
      <form
        className="hy-form"
        onSubmit={(e) => {
          e.preventDefault();
          void apply(drop, delay, jitter);
        }}
      >
        <label className="hy-slider">
          <span>
            Drop <span className="hy-val" aria-hidden="true">{drop}%</span>
          </span>
          <input type="range" min={0} max={100} step={1} value={drop} aria-valuetext={`${drop}%`} onChange={(e) => (setSeeded(true), setDrop(Number(e.target.value)))} />
        </label>
        <label className="hy-slider">
          <span>
            Delay <span className="hy-val" aria-hidden="true">{delay} ms</span>
          </span>
          <input type="range" min={0} max={2000} step={10} value={delay} aria-valuetext={`${delay} milliseconds`} onChange={(e) => (setSeeded(true), setDelay(Number(e.target.value)))} />
        </label>
        <label className="hy-slider">
          <span>
            Jitter <span className="hy-val" aria-hidden="true">{jitter} ms</span>
          </span>
          <input type="range" min={0} max={2000} step={10} value={jitter} aria-valuetext={`${jitter} milliseconds`} onChange={(e) => (setSeeded(true), setJitter(Number(e.target.value)))} />
        </label>
        <div className="hy-row">
          <button type="submit" className="hy-btn hy-btn-primary">
            Apply
          </button>
          {PRESETS.map((p) => (
            <button key={p.name} type="button" className="hy-btn" onClick={() => preset(p)}>
              {p.name}
            </button>
          ))}
          <button
            type="button"
            className="hy-btn"
            onClick={() => {
              setDrop(0);
              setDelay(0);
              setJitter(0);
              void adminFetch<ChaosState>(conn, "/api/chaos", { method: "POST", body: { reset: true } }).then(() => setNote("Chaos off: counters reset."), (e: unknown) => setFail(e instanceof Error ? e.message : "request failed"));
            }}
          >
            Reset
          </button>
          <button
            type="button"
            className="hy-btn"
            onClick={() => {
              void adminFetch<{ severed: number }>(conn, "/api/sever", { method: "POST", body: {} }).then(
                (r) => setNote(`Cut ${r.severed} connection${r.severed === 1 ? "" : "s"}. Clients will reconnect and replay what they missed.`),
                (e: unknown) => setFail(e instanceof Error ? e.message : "request failed"),
              );
            }}
          >
            Disconnect all
          </button>
        </div>
      </form>
      <dl className="hy-stats">
        <div>
          <dt>Dropped</dt>
          <dd>{data?.dropped ?? 0}</dd>
        </div>
        <div>
          <dt>Delayed</dt>
          <dd>{data?.delayed ?? 0}</dd>
        </div>
      </dl>
      <p className="hy-muted" role="status" aria-live="polite">
        {note}
      </p>
      {error || fail ? (
        <p className="hy-error" role="alert">
          {fail ?? error}
        </p>
      ) : null}
    </section>
  );
}

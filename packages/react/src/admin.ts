import { useCallback, useEffect, useRef, useState } from "react";

export interface AdminConnection {
  /** Base URL of the Hypout server, e.g. `http://localhost:4320`. Empty string means same origin. */
  baseUrl: string;
  /** An admin token (`hypout token mint --admin`, or the Studio link's `#token=`). */
  token: string;
}

export class AdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AdminError";
  }
}

export async function adminFetch<T>(c: AdminConnection, path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(`${c.baseUrl.replace(/\/$/, "")}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${c.token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  const body = (await res.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
  if (!res.ok) throw new AdminError(res.status, body?.error ?? body?.message ?? `HTTP ${res.status}`);
  return body as T;
}

export interface Polled<T> {
  data: T | null;
  error: string | null;
  refresh(): void;
}

/** Fetches `path` now and then every `everyMs` (pausing while the tab is hidden). */
export function usePolled<T>(c: AdminConnection, path: string, everyMs: number, enabled = true): Polled<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const live = useRef(true);
  const { baseUrl, token } = c;

  useEffect(() => {
    live.current = true;
    if (!enabled) return;
    const ctl = new AbortController();
    const load = async (): Promise<void> => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const d = await adminFetch<T>({ baseUrl, token }, path, { signal: ctl.signal });
        if (live.current) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (live.current && !ctl.signal.aborted) setError(e instanceof Error ? e.message : "request failed");
      }
    };
    void load();
    const id = setInterval(() => void load(), everyMs);
    return () => {
      live.current = false;
      ctl.abort();
      clearInterval(id);
    };
  }, [baseUrl, token, path, everyMs, enabled, tick]);

  return { data, error, refresh };
}

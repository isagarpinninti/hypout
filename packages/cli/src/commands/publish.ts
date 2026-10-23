import { UsageError } from "../args";

export interface PublishOptions {
  url: string;
  token: string;
  channel: string;
  event: string;
  data: unknown;
}

export type PublishResult = { ok: true; seq: number; ts: number } | { ok: false; status: number; code?: string; message: string };

export function parseData(raw: string | undefined): unknown {
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new UsageError(`the data argument is not valid JSON: ${raw.length > 60 ? `${raw.slice(0, 57)}...` : raw}`);
  }
}

export async function publish(o: PublishOptions): Promise<PublishResult> {
  let res: Response;
  try {
    res = await fetch(new URL("/api/publish", o.url), {
      method: "POST",
      headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" },
      body: JSON.stringify({ channel: o.channel, event: o.event, data: o.data }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return { ok: false, status: 0, message: `could not reach ${o.url}: ${e instanceof Error ? e.message : "network error"}` };
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; seq?: number; ts?: number; code?: string; message?: string; error?: string } | null;
  if (res.ok && body?.ok && typeof body.seq === "number") return { ok: true, seq: body.seq, ts: body.ts ?? 0 };
  const hint = res.status === 401 ? " (the token must be signed with the server's secret: set the same HYPOUT_SECRET, or run this from the project the server was started in)" : "";
  return { ok: false, status: res.status, ...(body?.code ? { code: body.code } : {}), message: `${body?.message ?? body?.error ?? `HTTP ${res.status}`}${hint}` };
}

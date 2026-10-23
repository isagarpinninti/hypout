import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type Op = "sub" | "pub" | "presence";

/** What a token lets its holder do: operations on channels matching a pattern (`chat:*`, `chat:room-1`, or `*`). */
export interface Capability {
  ch: string;
  ops: Op[];
}

export interface TokenClaims {
  /** Subject: the user id shown in presence. */
  sub: string;
  name?: string;
  avatar?: string;
  caps: Capability[];
  iat: number;
  exp: number;
  /** An admin token bypasses ACLs and rate limits (Studio and the REST API use one). */
  admin?: boolean;
}

export const TOKEN_PREFIX = "hpt_";

const b64 = (b: Uint8Array | string): string => Buffer.from(b).toString("base64url");

export function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

/** Mints `hpt_<claims>.<signature>`, signed with HMAC-SHA-256. Claims are visible (base64url JSON), not secret. */
export function mintToken(secret: string, claims: Omit<TokenClaims, "iat" | "exp"> & { ttlSeconds?: number }, now = Date.now()): string {
  const { ttlSeconds = 3600, ...rest } = claims;
  const body: TokenClaims = { ...rest, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + ttlSeconds };
  const payload = b64(JSON.stringify(body));
  const sig = createHmac("sha256", secret).update(payload).digest();
  return `${TOKEN_PREFIX}${payload}.${b64(sig)}`;
}

export type TokenCheck = { ok: true; claims: TokenClaims } | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyToken(secret: string, token: string, now = Date.now()): TokenCheck {
  if (!token.startsWith(TOKEN_PREFIX)) return { ok: false, reason: "malformed" };
  const [payload, sig, extra] = token.slice(TOKEN_PREFIX.length).split(".");
  if (!payload || !sig || extra !== undefined) return { ok: false, reason: "malformed" };
  const want = createHmac("sha256", secret).update(payload).digest();
  let got: Buffer;
  try {
    got = Buffer.from(sig, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "bad_signature" };
  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof claims.sub !== "string" || !Array.isArray(claims.caps) || typeof claims.exp !== "number") return { ok: false, reason: "malformed" };
  if (claims.exp * 1000 <= now) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

/** Does a capability pattern cover a channel? `*` covers all; `ns:*` covers `ns` and every `ns:...`. */
export function patternMatches(pattern: string, channel: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(":*")) {
    const ns = pattern.slice(0, -2);
    return channel === ns || channel.startsWith(`${ns}:`);
  }
  return pattern === channel;
}

export function allows(claims: Pick<TokenClaims, "caps" | "admin">, op: Op, channel: string): boolean {
  if (claims.admin) return true;
  return claims.caps.some((c) => c.ops.includes(op) && patternMatches(c.ch, channel));
}

/** Parses `chat:*=sub,pub;doc:*=sub,presence` (the CLI's flag format) into capabilities. */
export function parseCapabilities(spec: string): Capability[] {
  return spec
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const [ch, ops] = part.split("=");
      if (!ch || !ops) throw new Error(`capability "${part}" should look like channel=sub,pub`);
      const list = ops.split(",").map((o) => o.trim()) as Op[];
      for (const o of list) if (o !== "sub" && o !== "pub" && o !== "presence") throw new Error(`unknown operation "${o}" (use sub, pub or presence)`);
      return { ch, ops: list };
    });
}

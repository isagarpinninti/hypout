/**
 * RFC 6455 section 5: the WebSocket base framing protocol, written against Uint8Array only (no Buffer, no Node
 * APIs) so the identical code runs in Node and in the browser-based wire inspector.
 *
 *   0                   1                   2                   3
 *   0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 *  +-+-+-+-+-------+-+-------------+-------------------------------+
 *  |F|R|R|R| opcode|M| Payload len |    Extended payload length    |
 *  |I|S|S|S|  (4)  |A|     (7)     |             (16/64)           |
 *  |N|V|V|V|       |S|             |   (if payload len==126/127)   |
 *  | |1|2|3|       |K|             |                               |
 *  +-+-+-+-+-------+-+-------------+ - - - - - - - - - - - - - - - +
 *  |     Extended payload length continued, if payload len == 127  |
 *  + - - - - - - - - - - - - - - - +-------------------------------+
 *  |                               |Masking-key, if MASK set to 1  |
 *  +-------------------------------+-------------------------------+
 *  | Masking-key (continued)       |          Payload Data         |
 *  +-------------------------------- - - - - - - - - - - - - - - - +
 */

export const Opcode = {
  Continuation: 0x0,
  Text: 0x1,
  Binary: 0x2,
  Close: 0x8,
  Ping: 0x9,
  Pong: 0xa,
} as const;

export const OPCODE_NAMES: Record<number, string> = {
  0x0: "CONTINUATION",
  0x1: "TEXT",
  0x2: "BINARY",
  0x8: "CLOSE",
  0x9: "PING",
  0xa: "PONG",
};

/** Close status codes (RFC 6455 section 7.4.1) that Hypout sends. */
export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  ProtocolError: 1002,
  UnsupportedData: 1003,
  InvalidPayload: 1007,
  PolicyViolation: 1008,
  MessageTooBig: 1009,
  InternalError: 1011,
} as const;

/** A violation of RFC 6455. `code` is the close status the peer should be sent. */
export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly code: number = CloseCode.ProtocolError,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

const textEncoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

export const isControlOpcode = (opcode: number): boolean => (opcode & 0x8) !== 0;
const isReservedOpcode = (opcode: number): boolean => (opcode >= 0x3 && opcode <= 0x7) || opcode >= 0xb;

/** Close codes that may legally appear on the wire (1004, 1005, 1006 and 1015 never may). */
export function isValidCloseCode(code: number): boolean {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

/* ───────────────────────── encoding ───────────────────────── */

export interface EncodeOptions {
  opcode: number;
  payload?: Uint8Array | string;
  /** Default true. Set false for the first or middle frame of a fragmented message. */
  fin?: boolean;
  /** `true` picks a random 4-byte key (clients must mask); a 4-byte array uses that key (for tests). */
  mask?: boolean | Uint8Array;
  rsv1?: boolean;
}

function randomMaskKey(): Uint8Array {
  const key = new Uint8Array(4);
  globalThis.crypto.getRandomValues(key);
  return key;
}

/** XOR the payload with the 4-byte masking key. The same operation masks and unmasks. */
export function applyMask(payload: Uint8Array, key: Uint8Array): void {
  const n = payload.length;
  const k0 = key[0] as number;
  const k1 = key[1] as number;
  const k2 = key[2] as number;
  const k3 = key[3] as number;
  let i = 0;
  for (; i + 3 < n; i += 4) {
    payload[i] = (payload[i] as number) ^ k0;
    payload[i + 1] = (payload[i + 1] as number) ^ k1;
    payload[i + 2] = (payload[i + 2] as number) ^ k2;
    payload[i + 3] = (payload[i + 3] as number) ^ k3;
  }
  for (; i < n; i++) payload[i] = (payload[i] as number) ^ (key[i & 3] as number);
}

export function encodeFrame(options: EncodeOptions): Uint8Array {
  const payload = typeof options.payload === "string" ? textEncoder.encode(options.payload) : (options.payload ?? new Uint8Array(0));
  const fin = options.fin !== false;
  const opcode = options.opcode & 0x0f;
  if (isControlOpcode(opcode)) {
    if (payload.length > 125) throw new ProtocolError("control frames carry at most 125 bytes of payload");
    if (!fin) throw new ProtocolError("control frames cannot be fragmented");
  }
  const key = options.mask === true ? randomMaskKey() : options.mask instanceof Uint8Array ? options.mask : null;
  if (key && key.length !== 4) throw new RangeError("a masking key is 4 bytes");
  const len = payload.length;
  const extra = len < 126 ? 0 : len <= 0xffff ? 2 : 8;
  const frame = new Uint8Array(2 + extra + (key ? 4 : 0) + len);
  frame[0] = (fin ? 0x80 : 0) | (options.rsv1 ? 0x40 : 0) | opcode;
  let at = 2;
  if (len < 126) frame[1] = len;
  else if (len <= 0xffff) {
    frame[1] = 126;
    frame[2] = len >>> 8;
    frame[3] = len & 0xff;
    at = 4;
  } else {
    frame[1] = 127;
    const high = Math.floor(len / 0x100000000);
    const low = len >>> 0;
    frame[2] = (high >>> 24) & 0xff;
    frame[3] = (high >>> 16) & 0xff;
    frame[4] = (high >>> 8) & 0xff;
    frame[5] = high & 0xff;
    frame[6] = (low >>> 24) & 0xff;
    frame[7] = (low >>> 16) & 0xff;
    frame[8] = (low >>> 8) & 0xff;
    frame[9] = low & 0xff;
    at = 10;
  }
  if (key) {
    frame[1] = (frame[1] as number) | 0x80;
    frame.set(key, at);
    at += 4;
  }
  frame.set(payload, at);
  if (key) applyMask(frame.subarray(at, at + len), key);
  return frame;
}

export const encodeText = (text: string, mask?: boolean | Uint8Array): Uint8Array => encodeFrame({ opcode: Opcode.Text, payload: text, ...(mask !== undefined ? { mask } : {}) });
export const encodeBinary = (data: Uint8Array, mask?: boolean | Uint8Array): Uint8Array => encodeFrame({ opcode: Opcode.Binary, payload: data, ...(mask !== undefined ? { mask } : {}) });
export const encodePing = (payload?: Uint8Array | string, mask?: boolean | Uint8Array): Uint8Array =>
  encodeFrame({ opcode: Opcode.Ping, ...(payload !== undefined ? { payload } : {}), ...(mask !== undefined ? { mask } : {}) });
export const encodePong = (payload?: Uint8Array | string, mask?: boolean | Uint8Array): Uint8Array =>
  encodeFrame({ opcode: Opcode.Pong, ...(payload !== undefined ? { payload } : {}), ...(mask !== undefined ? { mask } : {}) });

/** A Close frame: a 2-byte status code followed by an optional UTF-8 reason (at most 123 bytes). */
export function encodeClose(code?: number, reason = "", mask?: boolean | Uint8Array): Uint8Array {
  if (code === undefined) return encodeFrame({ opcode: Opcode.Close, ...(mask !== undefined ? { mask } : {}) });
  const why = textEncoder.encode(reason).subarray(0, 123);
  const payload = new Uint8Array(2 + why.length);
  payload[0] = code >>> 8;
  payload[1] = code & 0xff;
  payload.set(why, 2);
  return encodeFrame({ opcode: Opcode.Close, payload, ...(mask !== undefined ? { mask } : {}) });
}

/** Splits a message into frames of at most `size` payload bytes (first frame carries the opcode, the rest are continuations). */
export function encodeFragmented(opcode: number, payload: Uint8Array, size: number, mask?: boolean): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < Math.max(payload.length, 1); at += size) {
    const chunk = payload.subarray(at, at + size);
    const last = at + size >= payload.length;
    out.push(encodeFrame({ opcode: at === 0 ? opcode : Opcode.Continuation, payload: chunk, fin: last, ...(mask ? { mask: true } : {}) }));
  }
  return out;
}

/* ───────────────────────── decoding ───────────────────────── */

export interface FrameInfo {
  fin: boolean;
  rsv1: boolean;
  rsv2: boolean;
  rsv3: boolean;
  opcode: number;
  masked: boolean;
  maskKey: Uint8Array | null;
  payloadLength: number;
  /** Bytes of header (2 to 14). */
  headerLength: number;
  /** The payload after XOR unmasking. */
  payload: Uint8Array;
  /** The frame exactly as it arrived (header and still-masked payload), when `keepWire` is on. */
  wire?: Uint8Array;
}

export type DecodedItem =
  | { kind: "frame"; frame: FrameInfo }
  | { kind: "message"; opcode: 1 | 2; text?: string; data?: Uint8Array; frames: number; length: number }
  | { kind: "ping"; payload: Uint8Array }
  | { kind: "pong"; payload: Uint8Array }
  | { kind: "close"; code: number | null; reason: string };

export interface DecoderOptions {
  /** Largest single frame payload accepted, checked from the header, before any payload is buffered. Default 64 KiB. */
  maxPayload?: number;
  /** Largest reassembled message. Default: `maxPayload`. */
  maxMessage?: number;
  /** A server decoder sets this: every client frame must be masked. */
  requireMask?: boolean;
  /** A client decoder sets this: server frames must not be masked. */
  forbidMask?: boolean;
  /** Also report every frame (for wire inspection). */
  emitFrames?: boolean;
  /** Keep a copy of each frame's raw bytes on `FrameInfo.wire`. */
  keepWire?: boolean;
}


/**
 * Reads one frame from `b[s..e)`. Returns null when the bytes so far are not a complete frame. Everything that can
 * be rejected from the first two header bytes is rejected immediately, so a hostile peer cannot make a server
 * wait for (or buffer) a frame it would refuse anyway.
 */
export function readFrame(b: Uint8Array, s: number, e: number, options: DecoderOptions, maxPayload: number): { frame: FrameInfo; consumed: number } | null {
  const avail = e - s;
  if (avail < 2) return null;
  const b0 = b[s] as number;
  const b1 = b[s + 1] as number;
  const fin = (b0 & 0x80) !== 0;
  const rsv1 = (b0 & 0x40) !== 0;
  const rsv2 = (b0 & 0x20) !== 0;
  const rsv3 = (b0 & 0x10) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  const len7 = b1 & 0x7f;

  if (rsv1 || rsv2 || rsv3) throw new ProtocolError("reserved bits must be 0 (no extension was negotiated)");
  if (isReservedOpcode(opcode)) throw new ProtocolError(`reserved opcode 0x${opcode.toString(16)}`);
  if (isControlOpcode(opcode) && (!fin || len7 > 125)) throw new ProtocolError("control frames must be final and carry at most 125 bytes");
  if (options.requireMask && !masked) throw new ProtocolError("client frames must be masked");
  if (options.forbidMask && masked) throw new ProtocolError("server frames must not be masked");

  const extra = len7 === 126 ? 2 : len7 === 127 ? 8 : 0;
  const headerLength = 2 + extra + (masked ? 4 : 0);
  if (avail < headerLength) return null;
  let length = len7;
  if (len7 === 126) {
    length = ((b[s + 2] as number) << 8) | (b[s + 3] as number);
    if (length < 126) throw new ProtocolError("payload length is not minimally encoded");
  } else if (len7 === 127) {
    const high = (((b[s + 2] as number) << 24) | ((b[s + 3] as number) << 16) | ((b[s + 4] as number) << 8) | (b[s + 5] as number)) >>> 0;
    const low = (((b[s + 6] as number) << 24) | ((b[s + 7] as number) << 16) | ((b[s + 8] as number) << 8) | (b[s + 9] as number)) >>> 0;
    if (high & 0x80000000) throw new ProtocolError("the most significant bit of a 64-bit length must be 0");
    length = high * 0x100000000 + low;
    if (length <= 0xffff) throw new ProtocolError("payload length is not minimally encoded");
  }
  if (length > maxPayload) throw new ProtocolError(`frame payload of ${length} bytes exceeds the ${maxPayload}-byte limit`, CloseCode.MessageTooBig);
  if (avail < headerLength + length) return null;

  const maskKey = masked ? b.slice(s + headerLength - 4, s + headerLength) : null;
  const payload = b.slice(s + headerLength, s + headerLength + length);
  const wire = options.keepWire ? b.slice(s, s + headerLength + length) : undefined;
  if (maskKey) applyMask(payload, maskKey);
  return { frame: { fin, rsv1, rsv2, rsv3, opcode, masked, maskKey, payloadLength: length, headerLength, payload, ...(wire ? { wire } : {}) }, consumed: headerLength + length };
}

/**
 * Incremental frame parser and message assembler. Feed it whatever the socket delivers, in any chunking, and it
 * returns the complete frames and messages found so far. Any violation throws a `ProtocolError` carrying the
 * close code to send; after that the decoder refuses input.
 */
export class FrameDecoder {
  private buf = new Uint8Array(4096);
  private start = 0;
  private end = 0;
  private fragOpcode = 0;
  private fragChunks: Uint8Array[] = [];
  private fragLen = 0;
  private fragFrames = 0;
  private done = false;
  private readonly maxPayload: number;
  private readonly maxMessage: number;

  constructor(private readonly options: DecoderOptions = {}) {
    this.maxPayload = options.maxPayload ?? 64 * 1024;
    this.maxMessage = options.maxMessage ?? this.maxPayload;
  }

  /** True once a Close frame was decoded or an error was thrown. */
  get closed(): boolean {
    return this.done;
  }

  /** Bytes buffered but not yet part of a complete frame. */
  get pending(): number {
    return this.end - this.start;
  }

  push(chunk: Uint8Array): DecodedItem[] {
    if (this.done) return [];
    this.append(chunk);
    const items: DecodedItem[] = [];
    try {
      while (!this.done) {
        const frame = this.parseOne();
        if (!frame) break;
        if (this.options.emitFrames) items.push({ kind: "frame", frame });
        this.dispatch(frame, items);
      }
    } catch (e) {
      this.done = true;
      throw e;
    }
    return items;
  }

  private append(chunk: Uint8Array): void {
    const need = this.end - this.start + chunk.length;
    if (this.end + chunk.length > this.buf.length) {
      const next = need > this.buf.length ? new Uint8Array(Math.max(need, this.buf.length * 2)) : this.buf;
      next.set(this.buf.subarray(this.start, this.end), 0);
      this.buf = next;
      this.end -= this.start;
      this.start = 0;
    }
    this.buf.set(chunk, this.end);
    this.end += chunk.length;
  }

  private parseOne(): FrameInfo | null {
    const read = readFrame(this.buf, this.start, this.end, this.options, this.maxPayload);
    if (!read) return null;
    this.start += read.consumed;
    if (this.start === this.end) this.start = this.end = 0;
    return read.frame;
  }

  private dispatch(frame: FrameInfo, out: DecodedItem[]): void {
    const { opcode, fin, payload } = frame;
    if (opcode === Opcode.Ping) return void out.push({ kind: "ping", payload });
    if (opcode === Opcode.Pong) return void out.push({ kind: "pong", payload });
    if (opcode === Opcode.Close) {
      this.done = true;
      if (payload.length === 0) return void out.push({ kind: "close", code: null, reason: "" });
      if (payload.length === 1) throw new ProtocolError("a close frame payload cannot be one byte");
      const code = ((payload[0] as number) << 8) | (payload[1] as number);
      if (!isValidCloseCode(code)) throw new ProtocolError(`invalid close code ${code}`);
      let reason: string;
      try {
        reason = strictDecoder.decode(payload.subarray(2));
      } catch {
        throw new ProtocolError("close reason is not valid UTF-8", CloseCode.InvalidPayload);
      }
      return void out.push({ kind: "close", code, reason });
    }
    // Data frames: a message is one frame (FIN set) or a start frame, continuations and a final frame.
    if (opcode === Opcode.Continuation) {
      if (!this.fragOpcode) throw new ProtocolError("continuation frame without a message in progress");
    } else if (this.fragOpcode) {
      throw new ProtocolError("a new message started before the previous one finished");
    } else {
      this.fragOpcode = opcode;
    }
    this.fragLen += payload.length;
    if (this.fragLen > this.maxMessage) throw new ProtocolError(`message exceeds the ${this.maxMessage}-byte limit`, CloseCode.MessageTooBig);
    this.fragChunks.push(payload);
    this.fragFrames++;
    if (!fin) return;
    const messageOpcode = this.fragOpcode;
    const data = this.fragChunks.length === 1 ? (this.fragChunks[0] as Uint8Array) : concat(this.fragChunks, this.fragLen);
    const frames = this.fragFrames;
    this.fragOpcode = 0;
    this.fragChunks = [];
    this.fragLen = 0;
    this.fragFrames = 0;
    if (messageOpcode === Opcode.Text) {
      let text: string;
      try {
        text = strictDecoder.decode(data);
      } catch {
        throw new ProtocolError("text message is not valid UTF-8", CloseCode.InvalidPayload);
      }
      out.push({ kind: "message", opcode: 1, text, frames, length: data.length });
    } else {
      out.push({ kind: "message", opcode: 2, data, frames, length: data.length });
    }
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Stateless parse of the complete frames at the start of a buffer: the frames, plus the bytes left over (the start
 * of an incomplete frame). Does not reassemble messages or validate sequencing; see `FrameDecoder` for that.
 */
export function decodeFrames(buffer: Uint8Array, options: DecoderOptions = {}): { frames: FrameInfo[]; rest: Uint8Array } {
  const maxPayload = options.maxPayload ?? 64 * 1024;
  const frames: FrameInfo[] = [];
  let at = 0;
  for (;;) {
    const read = readFrame(buffer, at, buffer.length, options, maxPayload);
    if (!read) break;
    frames.push(read.frame);
    at += read.consumed;
  }
  return { frames, rest: buffer.subarray(at) };
}

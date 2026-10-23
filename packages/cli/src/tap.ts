import { FrameDecoder, OPCODE_NAMES, hexdump } from "@hypout/core";

export interface WireEntry {
  id: number;
  ts: number;
  cid: string;
  dir: "in" | "out";
  opcode: number;
  name: string;
  fin: boolean;
  masked: boolean;
  length: number;
  /** Text payload (truncated) when the frame is text. */
  text: string | null;
  hex: string;
  /** The frame's first bytes as lowercase hex (header and still-masked payload), for in-browser decoding. */
  raw: string;
  dropped: boolean;
}

interface Stored extends Omit<WireEntry, "hex" | "raw"> {
  /** The first bytes of the frame. Hex and the hexdump are produced only when someone asks for them. */
  head: Uint8Array;
}

const KEEP_BYTES = 140;
const TEXT_PREVIEW = 600;

const nameOf = (opcode: number): string => OPCODE_NAMES[opcode] ?? `0x${opcode.toString(16)}`;

/** Keeps the last N frames that crossed the wire, for the Studio's frame inspector. Recording is cheap: no formatting happens until the entries are read. */
export class WireTap {
  private readonly entries: Stored[] = [];
  private nextId = 1;

  constructor(private readonly capacity = 500) {}

  get head(): number {
    return this.nextId - 1;
  }

  private push(entry: Omit<Stored, "id">): void {
    this.entries.push({ id: this.nextId++, ...entry });
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  /** A single unmasked frame the server just built (one text message), when its fields are already known. */
  recordOut(cid: string, bytes: Uint8Array, info: { opcode: number; payloadLength: number; text: string | null }, dropped = false, now = Date.now()): void {
    this.push({ ts: now, cid, dir: "out", opcode: info.opcode, name: nameOf(info.opcode), fin: true, masked: false, length: info.payloadLength, text: info.text === null ? null : info.text.slice(0, TEXT_PREVIEW), head: bytes.slice(0, KEEP_BYTES), dropped });
  }

  /** Decodes `bytes` (one or more complete frames) and stores them. Bytes that do not parse are ignored. */
  record(cid: string, dir: "in" | "out", bytes: Uint8Array, dropped = false, now = Date.now()): void {
    const decoder = new FrameDecoder({ emitFrames: true, keepWire: true, maxPayload: 16 * 1024 * 1024, maxMessage: 16 * 1024 * 1024, ...(dir === "in" ? { requireMask: true } : { forbidMask: true }) });
    let items;
    try {
      items = decoder.push(bytes);
    } catch {
      return;
    }
    for (const item of items) {
      if (item.kind !== "frame") continue;
      const f = item.frame;
      this.push({
        ts: now, cid, dir, opcode: f.opcode, name: nameOf(f.opcode), fin: f.fin, masked: f.masked, length: f.payloadLength,
        text: f.opcode === 1 ? new TextDecoder("utf-8", { fatal: false }).decode(f.payload.subarray(0, TEXT_PREVIEW)) : null,
        head: (f.wire ?? bytes).slice(0, KEEP_BYTES), dropped,
      });
    }
  }

  since(id = 0, limit = 200): WireEntry[] {
    return this.entries
      .filter((e) => e.id > id)
      .slice(-limit)
      .map(({ head, ...rest }) => ({ ...rest, hex: hexdump(head, { max: 96 }), raw: Array.from(head, (b) => b.toString(16).padStart(2, "0")).join("") }));
  }

  clear(): void {
    this.entries.length = 0;
  }
}

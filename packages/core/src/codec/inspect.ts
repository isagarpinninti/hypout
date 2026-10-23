import { OPCODE_NAMES } from "./frames";

/** Classic hex dump: offset, 16 bytes in hex, and the printable ASCII. `max` caps the bytes shown. */
export function hexdump(bytes: Uint8Array, options: { width?: number; max?: number } = {}): string {
  const width = options.width ?? 16;
  const shown = bytes.subarray(0, options.max ?? bytes.length);
  const lines: string[] = [];
  for (let at = 0; at < shown.length; at += width) {
    const row = shown.subarray(at, at + width);
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(width * 3 - 1, " ");
    const ascii = Array.from(row, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${at.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  if (shown.length < bytes.length) lines.push(`... ${bytes.length - shown.length} more bytes`);
  return lines.join("\n");
}

export interface HeaderField {
  name: string;
  /** The bits as a string, e.g. "1" or "0001". */
  bits: string;
  value: string;
  note?: string;
}

const bits = (n: number, width: number): string => n.toString(2).padStart(width, "0");

/** Explains the header of a frame, field by field and bit by bit, for the wire inspector. */
export function explainHeader(frame: Uint8Array): HeaderField[] {
  if (frame.length < 2) return [];
  const b0 = frame[0] as number;
  const b1 = frame[1] as number;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  const len7 = b1 & 0x7f;
  const fields: HeaderField[] = [
    { name: "FIN", bits: bits((b0 >> 7) & 1, 1), value: (b0 & 0x80) !== 0 ? "final fragment" : "more fragments follow" },
    { name: "RSV1", bits: bits((b0 >> 6) & 1, 1), value: "0 (no extension)" },
    { name: "RSV2", bits: bits((b0 >> 5) & 1, 1), value: "0 (no extension)" },
    { name: "RSV3", bits: bits((b0 >> 4) & 1, 1), value: "0 (no extension)" },
    { name: "Opcode", bits: bits(opcode, 4), value: `0x${opcode.toString(16)} ${OPCODE_NAMES[opcode] ?? "RESERVED"}` },
    { name: "MASK", bits: bits((b1 >> 7) & 1, 1), value: masked ? "payload is XOR-masked (client to server)" : "payload is not masked (server to client)" },
    { name: "Payload len", bits: bits(len7, 7), value: String(len7), note: len7 === 126 ? "length is in the next 2 bytes" : len7 === 127 ? "length is in the next 8 bytes" : undefined } as HeaderField,
  ];
  let at = 2;
  if (len7 === 126 && frame.length >= 4) {
    fields.push({ name: "Extended length (16-bit)", bits: bits(((frame[2] as number) << 8) | (frame[3] as number), 16), value: String(((frame[2] as number) << 8) | (frame[3] as number)) });
    at = 4;
  } else if (len7 === 127 && frame.length >= 10) {
    let len = 0;
    for (let i = 2; i < 10; i++) len = len * 256 + (frame[i] as number);
    fields.push({ name: "Extended length (64-bit)", bits: Array.from(frame.subarray(2, 10), (b) => bits(b, 8)).join(" "), value: String(len) });
    at = 10;
  }
  if (masked && frame.length >= at + 4) {
    const key = frame.subarray(at, at + 4);
    fields.push({ name: "Masking key", bits: Array.from(key, (b) => bits(b, 8)).join(" "), value: Array.from(key, (b) => b.toString(16).padStart(2, "0")).join(" ") });
  }
  return fields.map((f) => (f.note === undefined ? { name: f.name, bits: f.bits, value: f.value } : f));
}

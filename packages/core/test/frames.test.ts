import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CloseCode, FrameDecoder, Opcode, ProtocolError, applyMask, decodeFrames, encodeBinary, encodeClose, encodeFragmented, encodeFrame, encodePing, encodePong, encodeText, isValidCloseCode,
} from "../src/codec/frames";
import { explainHeader, hexdump } from "../src/codec/inspect";

const hex = (s: string): Uint8Array => Uint8Array.from(s.split(/\s+/).filter(Boolean).map((b) => parseInt(b, 16)));
const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const server = (o = {}): FrameDecoder => new FrameDecoder({ requireMask: true, ...o });
const client = (o = {}): FrameDecoder => new FrameDecoder({ forbidMask: true, ...o });

describe("RFC 6455 section 5.7 examples", () => {
  it("encodes a single-frame unmasked text message", () => {
    expect(encodeText("Hello")).toEqual(hex("81 05 48 65 6c 6c 6f"));
  });
  it("encodes a single-frame masked text message (key 37 fa 21 3d)", () => {
    expect(encodeText("Hello", hex("37 fa 21 3d"))).toEqual(hex("81 85 37 fa 21 3d 7f 9f 4d 51 58"));
  });
  it("decodes the masked example back to Hello", () => {
    const items = server().push(hex("81 85 37 fa 21 3d 7f 9f 4d 51 58"));
    expect(items).toEqual([{ kind: "message", opcode: 1, text: "Hello", frames: 1, length: 5 }]);
  });
  it("assembles a fragmented message (Hel + lo)", () => {
    const items = client().push(hex("01 03 48 65 6c 80 02 6c 6f"));
    expect(items).toEqual([{ kind: "message", opcode: 1, text: "Hello", frames: 2, length: 5 }]);
  });
  it("encodes ping and the masked pong reply", () => {
    expect(encodePing("Hello")).toEqual(hex("89 05 48 65 6c 6c 6f"));
    expect(encodePong("Hello", hex("37 fa 21 3d"))).toEqual(hex("8a 85 37 fa 21 3d 7f 9f 4d 51 58"));
  });
  it("uses the 16-bit length form for 256 bytes and the 64-bit form for 64 KiB", () => {
    const f256 = encodeBinary(new Uint8Array(256));
    expect([...f256.subarray(0, 4)]).toEqual([0x82, 0x7e, 0x01, 0x00]);
    const f64k = encodeBinary(new Uint8Array(65536));
    expect([...f64k.subarray(0, 10)]).toEqual([0x82, 0x7f, 0, 0, 0, 0, 0, 1, 0, 0]);
  });
});

describe("masking", () => {
  it("is its own inverse", () => {
    const data = new TextEncoder().encode("the quick brown fox");
    const copy = data.slice();
    applyMask(copy, hex("de ad be ef"));
    expect(copy).not.toEqual(data);
    applyMask(copy, hex("de ad be ef"));
    expect(copy).toEqual(data);
  });
  it("masks with a random key when asked and the server unmasks it", () => {
    const wire = encodeText("héllo wörld 🌱", true);
    expect(wire[1] as number & 0x80).toBeTruthy();
    expect(server().push(wire)[0]).toMatchObject({ kind: "message", text: "héllo wörld 🌱" });
  });
});

describe("decoding in any chunking", () => {
  it("handles bytes arriving one at a time", () => {
    const d = server();
    const out = [] as unknown[];
    for (const b of encodeText("a long-ish message that arrives slowly", true)) out.push(...d.push(Uint8Array.of(b)));
    expect(out).toHaveLength(1);
  });
  it("handles several frames in one chunk and a split in the middle of a header", () => {
    const a = encodeText("one", true);
    const b = encodeText("two", true);
    const c = encodeText("three", true);
    const all = new Uint8Array(a.length + b.length + c.length);
    all.set(a, 0);
    all.set(b, a.length);
    all.set(c, a.length + b.length);
    const d = server();
    const got = [...d.push(all.subarray(0, 1)), ...d.push(all.subarray(1, a.length + 3)), ...d.push(all.subarray(a.length + 3))];
    expect(got.map((i) => (i.kind === "message" ? i.text : ""))).toEqual(["one", "two", "three"]);
  });
  it("round-trips any string, any fragmentation and any chunking (property)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), fc.integer({ min: 1, max: 90 }), fc.integer({ min: 1, max: 30 }), (s, fragment, chunk) => {
        const payload = new TextEncoder().encode(s);
        const frames = encodeFragmented(Opcode.Text, payload, fragment, true);
        const wire = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
        let at = 0;
        for (const f of frames) {
          wire.set(f, at);
          at += f.length;
        }
        const d = server({ maxPayload: 1000, maxMessage: 5000 });
        const items = [];
        for (let i = 0; i < wire.length; i += chunk) items.push(...d.push(wire.subarray(i, i + chunk)));
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ kind: "message", text: s });
      }),
      { numRuns: 300 },
    );
  });
  it("answers control frames that arrive in the middle of a fragmented message", () => {
    const d = server();
    const first = encodeFrame({ opcode: Opcode.Text, payload: "Hel", fin: false, mask: true });
    const ping = encodePing("mid", true);
    const last = encodeFrame({ opcode: Opcode.Continuation, payload: "lo", mask: true });
    const items = [...d.push(first), ...d.push(ping), ...d.push(last)];
    expect(items.map((i) => i.kind)).toEqual(["ping", "message"]);
    expect(items[1]).toMatchObject({ text: "Hello", frames: 2 });
  });
  it("reports every frame when asked, with the raw wire bytes", () => {
    const wire = encodeText("hi", hex("01 02 03 04"));
    const items = server({ emitFrames: true, keepWire: true }).push(wire);
    expect(items[0]).toMatchObject({ kind: "frame", frame: { fin: true, opcode: 1, masked: true, payloadLength: 2, headerLength: 6 } });
    expect((items[0] as { frame: { wire: Uint8Array } }).frame.wire).toEqual(wire);
  });
});

describe("protocol violations are rejected with the right close code", () => {
  const code = (fn: () => unknown): number => {
    try {
      fn();
    } catch (e) {
      if (e instanceof ProtocolError) return e.code;
    }
    return -1;
  };
  it("unmasked client frame", () => expect(code(() => server().push(encodeText("x")))).toBe(1002));
  it("masked server frame", () => expect(code(() => client().push(encodeText("x", true)))).toBe(1002));
  it("reserved bits and reserved opcodes", () => {
    expect(code(() => server().push(encodeFrame({ opcode: Opcode.Text, payload: "x", mask: true, rsv1: true })))).toBe(1002);
    expect(code(() => server().push(hex("83 80 00 00 00 00")))).toBe(1002);
    expect(code(() => server().push(hex("8b 80 00 00 00 00")))).toBe(1002);
  });
  it("fragmented or oversized control frames", () => {
    expect(code(() => server().push(hex("09 80 00 00 00 00")))).toBe(1002);
    expect(code(() => server().push(hex("89 fe 00 7e 00 00 00 00")))).toBe(1002);
    expect(() => encodeFrame({ opcode: Opcode.Ping, payload: new Uint8Array(126) })).toThrow(ProtocolError);
  });
  it("continuation without a start, and a new message mid-fragment", () => {
    expect(code(() => server().push(encodeFrame({ opcode: Opcode.Continuation, payload: "x", mask: true })))).toBe(1002);
    const d = server();
    d.push(encodeFrame({ opcode: Opcode.Text, payload: "a", fin: false, mask: true }));
    expect(code(() => d.push(encodeFrame({ opcode: Opcode.Text, payload: "b", mask: true })))).toBe(1002);
  });
  it("non-minimal lengths and a set top bit in a 64-bit length", () => {
    expect(code(() => client().push(hex("81 7e 00 05 48 65 6c 6c 6f")))).toBe(1002);
    expect(code(() => client().push(hex("81 7f 00 00 00 00 00 00 00 05 48 65 6c 6c 6f")))).toBe(1002);
    expect(code(() => client().push(hex("81 7f 80 00 00 00 00 01 00 00")))).toBe(1002);
  });
  it("a payload over the limit is refused from the header alone (1009), without buffering it", () => {
    const d = server({ maxPayload: 1024 });
    const header = encodeFrame({ opcode: Opcode.Binary, payload: new Uint8Array(2000), mask: true }).subarray(0, 14);
    expect(code(() => d.push(header))).toBe(1009);
    expect(d.pending).toBeLessThanOrEqual(14);
  });
  it("a reassembled message over the limit (1009)", () => {
    const d = server({ maxPayload: 100, maxMessage: 150 });
    d.push(encodeFrame({ opcode: Opcode.Binary, payload: new Uint8Array(100), fin: false, mask: true }));
    expect(code(() => d.push(encodeFrame({ opcode: Opcode.Continuation, payload: new Uint8Array(100), mask: true })))).toBe(1009);
  });
  it("invalid UTF-8 in a text message (1007), but not in a binary one", () => {
    expect(code(() => server().push(encodeFrame({ opcode: Opcode.Text, payload: Uint8Array.of(0xff, 0xfe), mask: true })))).toBe(1007);
    expect(server().push(encodeFrame({ opcode: Opcode.Binary, payload: Uint8Array.of(0xff, 0xfe), mask: true }))[0]).toMatchObject({ kind: "message", opcode: 2 });
  });
  it("stops accepting input after an error or a Close", () => {
    const d = server();
    expect(() => d.push(encodeText("x"))).toThrow();
    expect(d.closed).toBe(true);
    expect(d.push(encodeText("y", true))).toEqual([]);
  });
});

describe("close frames", () => {
  it("round-trips a code and a reason", () => {
    const items = client().push(encodeClose(CloseCode.GoingAway, "bye"));
    expect(items).toEqual([{ kind: "close", code: 1001, reason: "bye" }]);
  });
  it("an empty close payload means no status", () => {
    expect(client().push(encodeClose())[0]).toEqual({ kind: "close", code: null, reason: "" });
  });
  it("validates codes: 1005/1006/1015 and 0-999 never appear on the wire", () => {
    for (const c of [0, 999, 1004, 1005, 1006, 1015, 1016, 2999, 5000]) expect(isValidCloseCode(c), String(c)).toBe(false);
    for (const c of [1000, 1001, 1003, 1007, 1011, 1013, 3000, 4999]) expect(isValidCloseCode(c), String(c)).toBe(true);
    expect(() => client().push(encodeClose(1005))).toThrow(ProtocolError);
    expect(() => client().push(hex("88 01 03"))).toThrow(ProtocolError);
  });
  it("truncates a long reason to fit the 125-byte control limit", () => {
    expect(encodeClose(1000, "x".repeat(500)).length).toBeLessThanOrEqual(2 + 125);
  });
});

describe("decodeFrames (stateless)", () => {
  it("returns complete frames and the leftover bytes", () => {
    const a = encodeText("one", true);
    const b = encodeText("second", true);
    const { frames, rest } = decodeFrames(new Uint8Array([...a, ...b.subarray(0, 5)]), { requireMask: true });
    expect(frames).toHaveLength(1);
    expect(text(frames[0]?.payload ?? new Uint8Array())).toBe("one");
    expect(rest.length).toBe(5);
  });
});

describe("inspection helpers", () => {
  it("dumps hex with an ASCII column", () => {
    expect(hexdump(hex("81 05 48 65 6c 6c 6f"))).toBe("00000000  81 05 48 65 6c 6c 6f                             |..Hello|");
  });
  it("explains each header field", () => {
    const f = explainHeader(encodeText("Hello", hex("37 fa 21 3d")));
    expect(f.map((x) => x.name)).toEqual(["FIN", "RSV1", "RSV2", "RSV3", "Opcode", "MASK", "Payload len", "Masking key"]);
    expect(f.find((x) => x.name === "Opcode")?.value).toContain("TEXT");
    expect(f.find((x) => x.name === "Masking key")?.value).toBe("37 fa 21 3d");
  });
});

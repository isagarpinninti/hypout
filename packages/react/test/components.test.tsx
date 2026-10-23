import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelTopologyStudio, ChaosDropSimulator, HypoutClient, HypoutProvider, LivePresenceRoster, WireFrameInspector, type SocketLike } from "../src";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

class Sock implements SocketLike {
  static last: Sock;
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  onopen = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror = null;
  constructor() {
    Sock.last = this;
  }
  send(d: string): void {
    this.sent.push(JSON.parse(d) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
  }
  receive(m: object): void {
    act(() => this.onmessage?.({ data: JSON.stringify(m) }));
  }
}
const op = (k: string, f: string, v: unknown, ts: number) => ({ k, f, v, ts, a: "s" });

describe("LivePresenceRoster", () => {
  it("lists members, marks you, collapses the overflow, and announces joins and leaves", async () => {
    const client = new HypoutClient({ url: "ws://x", socket: () => new Sock(), autoConnect: false });
    client.connect();
    await waitFor(() => expect(Sock.last).toBeDefined());
    render(
      <HypoutProvider client={client}>
        <LivePresenceRoster channel="room:1" maxVisible={2} />
      </HypoutProvider>,
    );
    expect(screen.getByText("Connecting…")).toBeTruthy();
    Sock.last.receive({ t: "welcome", cid: "c_a", serverTime: 0, heartbeat: { intervalMs: 1, timeoutMs: 1 }, maxPayload: 1, authenticated: true });
    Sock.last.receive({
      t: "presence.snapshot", ch: "room:1", members: [],
      ops: [op("c_a", "$alive", true, 1), op("c_a", "name", "Ada Lovelace", 2), op("c_b", "$alive", true, 3), op("c_b", "userId", "bob", 4), op("c_b", "status", "typing", 5), op("c_c", "$alive", true, 6), op("c_c", "name", "Cy", 7)],
    });
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(3); // two people and "+1 more"
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("(you)")).toBeTruthy();
    expect(screen.getByText("typing")).toBeTruthy();
    expect(screen.getByText("+1 more")).toBeTruthy();
    expect(screen.getByLabelText("3 online")).toBeTruthy();
    Sock.last.receive({ t: "presence.diff", ch: "room:1", joined: [], left: [], updated: [], ops: [op("c_b", "$alive", false, 9)] });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("bob left"));
    expect(screen.getByLabelText("2 online")).toBeTruthy();
  });

  it("announces its own state on the channel", async () => {
    const client = new HypoutClient({ url: "ws://x", socket: () => new Sock(), autoConnect: false });
    client.connect();
    await waitFor(() => expect(Sock.last).toBeDefined());
    render(
      <HypoutProvider client={client}>
        <LivePresenceRoster channel="room:1" state={{ name: "Ada" }} />
      </HypoutProvider>,
    );
    Sock.last.receive({ t: "welcome", cid: "c_me", serverTime: 0, heartbeat: { intervalMs: 1, timeoutMs: 1 }, maxPayload: 1, authenticated: true });
    expect(Sock.last.sent).toContainEqual({ t: "presence", ch: "room:1", op: "set", state: { name: "Ada" } });
  });
});

function stubFetch(routes: Record<string, (init: RequestInit | undefined) => unknown>): ReturnType<typeof vi.fn> {
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://h").pathname + new URL(url, "http://h").search;
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    if (!key) return new Response(JSON.stringify({ error: "nope" }), { status: 404 });
    return new Response(JSON.stringify(routes[key]?.(init)), { status: 200 });
  });
  vi.stubGlobal("fetch", f);
  return f;
}

describe("ChannelTopologyStudio", () => {
  it("shows namespaces, access and live channels in an accessible table", async () => {
    stubFetch({
      "/api/channels": () => ({
        namespaces: [
          { namespace: "chat", access: { subscribe: "public", publish: "token", presence: "public" }, events: { message: {} } },
          { namespace: "alerts", access: { subscribe: "public", publish: "server", presence: "off" }, events: {} },
        ],
        channels: [{ name: "chat:r1", subscribers: 3, head: 12, retained: 12, members: 2 }],
      }),
    });
    const picked: string[] = [];
    render(<ChannelTopologyStudio baseUrl="http://h" token="t" onSelectChannel={(n) => picked.push(n)} />);
    await screen.findByText("2 namespaces · 1 live channels");
    const table = screen.getByRole("table");
    expect(within(table).getByRole("rowheader", { name: "chat" })).toBeTruthy();
    expect(within(table).getByText("pub server")).toBeTruthy();
    fireEvent.click(within(table).getByRole("button", { name: "chat:r1" }));
    expect(picked).toEqual(["chat:r1"]);
  });
  it("reports an unreachable server", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "an admin token is required" }), { status: 401 })));
    render(<ChannelTopologyStudio baseUrl="" token="bad" />);
    expect((await screen.findByRole("alert")).textContent).toContain("an admin token is required");
  });
});

const frame = (id: number, over: object = {}) => ({
  id, ts: 1_700_000_000_000 + id, cid: "c_abcdef", dir: "in", opcode: 1, name: "Text", fin: true, masked: true, length: 5, text: "hello", hex: "00000000  81 85", raw: "818537fa213d7f9f4d5158", dropped: false, ...over,
});

describe("WireFrameInspector", () => {
  it("lists frames, filters them, and decodes the selected header in the browser", async () => {
    stubFetch({ "/api/wire": () => ({ head: 3, frames: [frame(1), frame(2, { dir: "out", name: "Ping", opcode: 9, text: null, length: 0, raw: "8900" }), frame(3, { dropped: true, dir: "out", text: '{"t":"event"}' })] }) });
    render(<WireFrameInspector baseUrl="" token="t" pollMs={5000} />);
    await screen.findByText("hello");
    expect(screen.getAllByText("dropped")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Direction"), { target: { value: "in" } });
    expect(screen.queryByText("Ping")).toBeNull();
    fireEvent.change(screen.getByLabelText("Direction"), { target: { value: "all" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Text" })[0] as HTMLElement);
    const detail = screen.getByLabelText("Frame detail");
    expect(within(detail).getByText("FIN")).toBeTruthy();
    expect(within(detail).getByText("MASK")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter frames"), { target: { value: "zzz" } });
    expect(screen.getByText("No frames match.")).toBeTruthy();
  });
  it("pauses polling and asks the server to clear", async () => {
    const f = stubFetch({ "/api/wire": (init) => (init?.method === "DELETE" ? { ok: true } : { head: 1, frames: [frame(1)] }) });
    render(<WireFrameInspector baseUrl="" token="t" pollMs={20} />);
    await screen.findByText("hello");
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    const calls = f.mock.calls.length;
    await new Promise((r) => setTimeout(r, 90));
    expect(f.mock.calls.length).toBe(calls);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("No frames yet. Connect a client.")).toBeTruthy();
    expect(f.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === "DELETE")).toBe(true);
  });
});

describe("ChaosDropSimulator", () => {
  it("sends the slider values, applies presets, resets, and can cut connections", async () => {
    const state = { dropRate: 0, delayMs: 0, jitterMs: 0, seed: 1, active: false, dropped: 4, delayed: 1 };
    const f = stubFetch({
      "/api/chaos": (init) => {
        if (init?.method === "POST") {
          const b = JSON.parse(String(init.body)) as Record<string, number>;
          Object.assign(state, b, { active: (b["dropRate"] ?? 0) > 0 });
        }
        return state;
      },
      "/api/sever": () => ({ severed: 2 }),
    });
    render(<ChaosDropSimulator baseUrl="" token="t" pollMs={5000} />);
    await screen.findByText("4");
    fireEvent.change(screen.getByLabelText(/Drop/), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("dropping 30%"));
    const body = JSON.parse(String((f.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === "POST")?.[1] as RequestInit).body));
    expect(body).toEqual({ dropRate: 0.3, delayMs: 0, jitterMs: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Tunnel" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("dropping 50%"));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect all" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Cut 2 connections"));
    fireEvent.click(screen.getByRole("button", { name: "Clean" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Chaos off"));
  });
  it("shows the server's refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => (init?.method === "POST" ? new Response(JSON.stringify({ error: "dropRate must be between 0 and 1" }), { status: 400 }) : new Response(JSON.stringify({ dropRate: 0, delayMs: 0, jitterMs: 0, seed: 1, active: false, dropped: 0, delayed: 0 }), { status: 200 }))));
    render(<ChaosDropSimulator baseUrl="" token="t" pollMs={5000} />);
    await screen.findByText("Dropped");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect((await screen.findByRole("alert")).textContent).toContain("dropRate must be between 0 and 1");
  });
});

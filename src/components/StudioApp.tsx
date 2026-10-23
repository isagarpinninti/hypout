"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChannelTopologyStudio, ChaosDropSimulator, HypoutClient, HypoutLogo, HypoutProvider, LivePresenceRoster, WireFrameInspector, useConnectionStatus } from "@hypout/react";
import { ChannelList } from "./ChannelList";
import { ConnectForm } from "./ConnectForm";
import { FeedPanel } from "./FeedPanel";
import { ThemeToggle } from "./ThemeToggle";
import { forgetConnection, readConnection, saveConnection, wsUrl, type Connection } from "../lib/connection";

type Tab = "feed" | "wire" | "topology" | "chaos";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "feed", label: "Live feed" },
  { id: "wire", label: "Wire frames" },
  { id: "topology", label: "Topology" },
  { id: "chaos", label: "Chaos" },
];

export function StudioApp(): ReactNode {
  const [conn, setConn] = useState<Connection | null>(null);
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    const c = readConnection();
    if (c) {
      saveConnection(c);
      setConn(c);
    }
    setReady(true);
  }, []);

  if (!ready) return null;
  if (!conn) {
    return (
      <ConnectForm
        initialError={problem}
        onConnect={(c) => {
          saveConnection(c);
          setProblem("");
          setConn(c);
        }}
      />
    );
  }
  return (
    <Studio
      conn={conn}
      onDisconnect={(why) => {
        forgetConnection();
        setProblem(why);
        setConn(null);
      }}
    />
  );
}

function Studio({ conn, onDisconnect }: { conn: Connection; onDisconnect(reason: string): void }): ReactNode {
  const client = useMemo(() => new HypoutClient({ url: wsUrl(conn.baseUrl), token: conn.token, autoConnect: false }), [conn]);
  useEffect(() => {
    client.connect();
    return () => client.close();
  }, [client]);

  const [channel, setChannel] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("feed");

  // A rejected token surfaces as a REST failure; check it once so the user lands on the form with a reason.
  useEffect(() => {
    const ctl = new AbortController();
    fetch(`${conn.baseUrl}/api/stats`, { headers: { authorization: `Bearer ${conn.token}` }, signal: ctl.signal }).then(
      (r) => {
        if (r.status === 401) onDisconnect("That token was refused. It may have expired (admin tokens last 24 hours): restart `hypout studio` or mint a new one.");
      },
      () => undefined,
    );
    return () => ctl.abort();
  }, [conn, onDisconnect]);

  return (
    <HypoutProvider client={client}>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-ink focus:px-3 focus:py-2 focus:text-bg">
        Skip to content
      </a>
      <div className="flex min-h-screen flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex items-center gap-4">
            <HypoutLogo size={28} />
            <span className="text-muted">Studio</span>
          </div>
          <div className="flex items-center gap-3">
            <StatusPill server={conn.baseUrl} />
            <ThemeToggle />
            <button type="button" className="hy-btn" onClick={() => onDisconnect("")}>
              Disconnect
            </button>
          </div>
        </header>
        <div className="grid flex-1 gap-4 p-4 lg:grid-cols-[250px_minmax(0,1fr)_300px]">
          <div className="lg:sticky lg:top-4 lg:self-start">
            <ChannelList conn={conn} selected={channel} onSelect={(c) => (setChannel(c), setTab("feed"))} />
          </div>
          <main id="main" className="min-w-0">
            <div role="tablist" aria-label="Views" className="mb-4 flex flex-wrap gap-1 border-b border-line">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  type="button"
                  id={`tab-${t.id}`}
                  aria-selected={tab === t.id}
                  aria-controls={`panel-${t.id}`}
                  tabIndex={tab === t.id ? 0 : -1}
                  onClick={() => setTab(t.id)}
                  onKeyDown={(e) => {
                    const i = TABS.findIndex((x) => x.id === tab);
                    const n = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
                    if (n < 0) return;
                    e.preventDefault();
                    const target = TABS[(n + TABS.length) % TABS.length];
                    if (target) {
                      setTab(target.id);
                      document.getElementById(`tab-${target.id}`)?.focus();
                    }
                  }}
                  className={`-mb-px border-b-2 px-3 py-2 ${tab === t.id ? "border-ink font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {/* The feed stays mounted (hidden) while you look at other views, so its subscription and history keep going. */}
            <div role="tabpanel" id="panel-feed" aria-labelledby="tab-feed" tabIndex={0} hidden={tab !== "feed"}>
              {channel ? <FeedPanel key={channel} conn={conn} channel={channel} /> : <p className="hy-empty">Pick a channel on the left to watch it live and publish to it.</p>}
            </div>
            {tab === "wire" ? (
              <div role="tabpanel" id="panel-wire" aria-labelledby="tab-wire" tabIndex={0}>
                <WireFrameInspector baseUrl={conn.baseUrl} token={conn.token} />
              </div>
            ) : null}
            {tab === "topology" ? (
              <div role="tabpanel" id="panel-topology" aria-labelledby="tab-topology" tabIndex={0}>
                <ChannelTopologyStudio baseUrl={conn.baseUrl} token={conn.token} onSelectChannel={(c) => (setChannel(c), setTab("feed"))} />
              </div>
            ) : null}
            {tab === "chaos" ? (
              <div role="tabpanel" id="panel-chaos" aria-labelledby="tab-chaos" tabIndex={0}>
                <ChaosDropSimulator baseUrl={conn.baseUrl} token={conn.token} />
              </div>
            ) : null}
          </main>
          <aside aria-label="Presence" className="grid content-start gap-4">
            {channel ? <LivePresenceRoster channel={channel} /> : <p className="hy-empty">Presence appears here once you open a channel.</p>}
          </aside>
        </div>
      </div>
    </HypoutProvider>
  );
}

function StatusPill({ server }: { server: string }): ReactNode {
  const status = useConnectionStatus();
  const ok = status === "open";
  return (
    <span className="hy-badge" role="status" aria-live="polite">
      <span className={`hy-dot ${ok ? "hy-dot-ok" : "hy-dot-off"}`} aria-hidden="true" />
      {ok ? "connected" : status} · {server.replace(/^https?:\/\//, "")}
    </span>
  );
}

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { HypoutEvent, Json, Member } from "@hypout/core/protocol";
import { HypoutClient, type ConnectionStatus, type HypoutClientOptions, type HypoutError } from "./client";

const Context = createContext<HypoutClient | null>(null);

export interface HypoutProviderProps {
  /** Pass an existing client, or the options to create one (it is closed when the provider unmounts). */
  client?: HypoutClient;
  options?: HypoutClientOptions;
  children?: ReactNode;
}

export function HypoutProvider({ client, options, children }: HypoutProviderProps): ReactNode {
  const url = options?.url;
  const token = typeof options?.token === "string" ? options.token : undefined;
  const owned = useMemo(() => {
    if (client || !options) return null;
    return new HypoutClient({ ...options, autoConnect: false });
    // The client is rebuilt only when the URL or a string token changes; function tokens are read at connect time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, url, token]);
  useEffect(() => {
    if (!owned) return;
    owned.connect();
    return () => owned.close();
  }, [owned]);
  const value = client ?? owned;
  if (!value) throw new Error("HypoutProvider needs a client or options");
  return createElement(Context.Provider, { value }, children);
}

export function useHypoutClient(): HypoutClient {
  const c = useContext(Context);
  if (!c) throw new Error("useHypoutClient must be used inside <HypoutProvider>");
  return c;
}

export function useConnectionStatus(): ConnectionStatus {
  const client = useHypoutClient();
  return useSyncExternalStore(
    (cb) => client.onStatus(cb),
    () => client.status,
    () => "idle" as const,
  );
}

export interface UseChannelOptions {
  /** Keep only this many recent events in state. Default 100. */
  limit?: number;
  /** Only keep events with this name. */
  event?: string;
  enabled?: boolean;
}

export interface ChannelEvent extends HypoutEvent {
  channel: string;
  replay: boolean;
}

export interface UseChannel {
  events: ChannelEvent[];
  /** The highest sequence number received. */
  head: number;
  subscribed: boolean;
  /** True when the server could not replay everything that was missed. */
  gap: boolean;
  error: HypoutError | null;
  publish(event: string, data: Json): Promise<{ seq: number }>;
}

export function useChannel(channel: string, options: UseChannelOptions = {}): UseChannel {
  const client = useHypoutClient();
  const { limit = 100, event, enabled = true } = options;
  const [events, setEvents] = useState<ChannelEvent[]>([]);
  const [subscribed, setSubscribed] = useState(false);
  const [gap, setGap] = useState(false);
  const [error, setError] = useState<HypoutError | null>(null);
  const [head, setHead] = useState(0);
  const status = useConnectionStatus();

  useEffect(() => {
    setEvents([]);
    setHead(0);
    setGap(false);
    setError(null);
    if (!enabled) return;
    return client.subscribe(channel, {
      onSubscribed: (i) => {
        setSubscribed(true);
        setGap(i.gap);
        setError(null);
      },
      onEvent: (e) => {
        setHead(e.seq);
        if (event && e.ev !== event) return;
        setEvents((prev) => [...prev, e].slice(-limit));
      },
      onError: setError,
    });
  }, [client, channel, event, limit, enabled]);

  useEffect(() => {
    if (status !== "open") setSubscribed(false);
  }, [status]);

  const publish = useCallback((ev: string, data: Json) => client.publish(channel, ev, data), [client, channel]);
  return { events, head, subscribed, gap, error, publish };
}

export interface UsePresence {
  members: Member[];
  /** This client's own entry, once the server has echoed it. */
  self: Member | null;
  setState(state: Record<string, Json>): void;
}

/** Subscribes to a channel's presence. Pass `state` to announce yourself (it is re-sent after reconnects). */
export function usePresence(channel: string, state?: Record<string, Json>): UsePresence {
  const client = useHypoutClient();
  const [members, setMembers] = useState<Member[]>([]);
  const stateKey = state ? JSON.stringify(state) : null;
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    setMembers(client.members(channel));
    const off = client.subscribe(channel, { onPresence: setMembers });
    return off;
  }, [client, channel]);

  useEffect(() => {
    if (stateKey !== null && latest.current) client.setPresence(channel, latest.current);
  }, [client, channel, stateKey]);

  const self = members.find((m) => m.key === client.connectionId) ?? null;
  const setState = useCallback((s: Record<string, Json>) => client.setPresence(channel, s), [client, channel]);
  return { members, self, setState };
}

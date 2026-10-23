import type { ChannelDefinition } from "@hypout/core/protocol";

export interface ChannelStat {
  name: string;
  subscribers: number;
  head: number;
  retained: number;
  members: number;
}

export interface ChannelsResponse {
  namespaces: ChannelDefinition[];
  channels: ChannelStat[];
}

export interface StatsResponse {
  version: string;
  uptimeMs: number;
  connections: number;
  subscriptions: number;
  channels: ChannelStat[];
  counters: { published: number; delivered: number; replayed: number; rejected: Record<string, number> };
  chaos: ChaosState;
  ledger: { entries: number; head: string } | null;
  maxPayload: number;
  wireHead: number;
}

export interface ChaosState {
  dropRate: number;
  delayMs: number;
  jitterMs: number;
  seed: number;
  active: boolean;
  dropped: number;
  delayed: number;
}

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
  text: string | null;
  hex: string;
  raw: string;
  dropped: boolean;
}

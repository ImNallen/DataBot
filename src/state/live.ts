import { create } from "zustand";
import type {
  AppEvent,
  BootSnapshot,
  ConnectionId,
  ConnectionState,
  ConsoleState,
  HistoryEntry,
  OutputEntry,
  TabId,
} from "../ipc/bindings";

export const OUTPUT_LIMIT = 5_000;
const HISTORY_TAIL_LIMIT = 200;

export type LiveData = {
  connections: Record<ConnectionId, ConnectionState>;
  consoles: Record<TabId, ConsoleState>;
  output: Record<TabId, OutputEntry[]>;
  /** Highest catalog version announced per connection, from either source that carries one. */
  catalogVersions: Record<ConnectionId, number>;
  /** Entries appended since boot, newest first; the History panel merges them over its fetched page. */
  historyTail: HistoryEntry[];
};

type LiveState = LiveData & {
  hydrate(b: BootSnapshot): void;
  apply(e: AppEvent): void;
};

export const emptyLive: LiveData = { connections: {}, consoles: {}, output: {}, catalogVersions: {}, historyTail: [] };

function keepHigher<K extends string, V extends { rev: number }>(map: Record<K, V>, key: K, next: V): Record<K, V> {
  const prev = map[key];
  return prev && prev.rev >= next.rev ? map : { ...map, [key]: next };
}

function bumpVersion(versions: Record<ConnectionId, number>, id: ConnectionId, version: number) {
  return (versions[id] ?? -1) >= version ? versions : { ...versions, [id]: version };
}

function connectionVersion(state: ConnectionState): number | null {
  return state.status.kind === "Connected" ? state.status.catalogVersion : null;
}

function withConnection(s: LiveData, state: ConnectionState): Partial<LiveData> {
  const connections = keepHigher(s.connections, state.id, state);
  const version = connectionVersion(state);
  return {
    connections,
    catalogVersions: version === null ? s.catalogVersions : bumpVersion(s.catalogVersions, state.id, version),
  };
}

/** The reducer, exported pure so tests and the fake engine can drive it without the store. */
export function applyEvent(s: LiveData, e: AppEvent): LiveData {
  switch (e.kind) {
    case "ConnectionChanged": {
      const { kind: _, ...state } = e;
      return { ...s, ...withConnection(s, state) };
    }
    case "CatalogChanged":
      return { ...s, catalogVersions: bumpVersion(s.catalogVersions, e.connectionId, e.version) };
    case "ConsoleChanged": {
      const { kind: _, ...state } = e;
      return { ...s, consoles: keepHigher(s.consoles, state.tabId, state) };
    }
    case "ConsoleOutput": {
      const prev = s.output[e.tabId] ?? [];
      const next = prev.concat(e.entries);
      return { ...s, output: { ...s.output, [e.tabId]: next.length > OUTPUT_LIMIT ? next.slice(-OUTPUT_LIMIT) : next } };
    }
    case "HistoryAppended": {
      const { kind: _, ...entry } = e;
      return { ...s, historyTail: [entry, ...s.historyTail].slice(0, HISTORY_TAIL_LIMIT) };
    }
    default: {
      const unreachable: never = e;
      return unreachable;
    }
  }
}

export function hydrateLive(s: LiveData, b: BootSnapshot): LiveData {
  let next = s;
  for (const c of b.live) next = { ...next, ...withConnection(next, c) };
  for (const c of b.consoles) next = { ...next, consoles: keepHigher(next.consoles, c.tabId, c) };
  return next;
}

export const useLive = create<LiveState>()((set) => ({
  ...emptyLive,
  hydrate: (b) => set((s) => hydrateLive(s, b)),
  apply: (e) => set((s) => applyEvent(s, e)),
}));

import { create } from "zustand";
import type {
  AppEvent,
  BootSnapshot,
  ConnectionId,
  ConnectionState,
  ConsoleState,
  DatabaseRef,
  DatabaseState,
  HistoryEntry,
  InstanceState,
  OutputEntry,
  TabId,
} from "../ipc/bindings";
import { dbKey, type DbKey } from "./dbKey";

export const OUTPUT_LIMIT = 5_000;
const HISTORY_TAIL_LIMIT = 200;

export type LiveData = {
  connections: Record<ConnectionId, ConnectionState>;
  consoles: Record<TabId, ConsoleState>;
  output: Record<TabId, OutputEntry[]>;
  historyTail: HistoryEntry[];
};

type LiveState = LiveData & {
  hydrate(b: BootSnapshot): void;
  apply(e: AppEvent): void;
};

export const emptyLive: LiveData = { connections: {}, consoles: {}, output: {}, historyTail: [] };

function keepHigher<K extends string, V extends { rev: number }>(map: Record<K, V>, key: K, next: V): Record<K, V> {
  const prev = map[key];
  return prev && prev.rev >= next.rev ? map : { ...map, [key]: next };
}

export function instanceOf(state: ConnectionState | undefined): InstanceState | null {
  return state?.status.kind === "Connected" ? state.status.instance : null;
}

/** The version `catalog_get` serves for a database: the Ready one, or the last good one behind a failed reload. */
function servedVersion(catalog: DatabaseState["catalog"]): number | null {
  switch (catalog.kind) {
    case "Ready":
      return catalog.version;
    case "Failed":
      return catalog.version;
    case "Idle":
    case "Loading":
      return null;
    default: {
      const unreachable: never = catalog;
      return unreachable;
    }
  }
}

/** Every served catalog across the connected instances: what the catalog store must hold, and at which version. */
export function wantedCatalogs(connections: Record<ConnectionId, ConnectionState>): Map<DbKey, { ref: DatabaseRef; version: number }> {
  const wanted = new Map<DbKey, { ref: DatabaseRef; version: number }>();
  for (const conn of Object.values(connections)) {
    for (const db of instanceOf(conn)?.databases ?? []) {
      const version = servedVersion(db.catalog);
      if (version === null) continue;
      const ref = { connectionId: conn.id, database: db.name };
      wanted.set(dbKey(ref), { ref, version });
    }
  }
  return wanted;
}

export function applyEvent(s: LiveData, e: AppEvent): LiveData {
  switch (e.kind) {
    case "ConnectionChanged": {
      const { kind: _, ...state } = e;
      return { ...s, connections: keepHigher(s.connections, state.id, state) };
    }
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
  for (const c of b.live) next = { ...next, connections: keepHigher(next.connections, c.id, c) };
  for (const c of b.consoles) next = { ...next, consoles: keepHigher(next.consoles, c.tabId, c) };
  return next;
}

export const useLive = create<LiveState>()((set) => ({
  ...emptyLive,
  hydrate: (b) => set((s) => hydrateLive(s, b)),
  apply: (e) => set((s) => applyEvent(s, e)),
}));

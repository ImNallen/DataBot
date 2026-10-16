import { create } from "zustand";
import type {
  AppEvent,
  BootSnapshot,
  ChatId,
  ChatState,
  ChatView,
  ConnectionId,
  ConnectionState,
  ConsoleState,
  DatabaseRef,
  DatabaseState,
  EntrySnapshot,
  HistoryEntry,
  InstanceState,
  OutputEntry,
  ProviderKind,
  ProviderState,
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
  providers: Partial<Record<ProviderKind, ProviderState>>;
  chats: Record<ChatId, ChatState>;
  /** Only chats the panel opened. Entry events for other chats are dropped; opening loads them whole. */
  transcripts: Record<ChatId, Record<number, EntrySnapshot>>;
};

type LiveState = LiveData & {
  hydrate(b: BootSnapshot): void;
  hydrateChat(view: ChatView): void;
  apply(e: AppEvent): void;
};

export const emptyLive: LiveData = { connections: {}, consoles: {}, output: {}, historyTail: [], providers: {}, chats: {}, transcripts: {} };

function keepHigher<K extends PropertyKey, V extends { rev: number }, M extends Partial<Record<K, V>>>(map: M, key: K, next: V): M {
  const prev = map[key];
  return prev && prev.rev >= next.rev ? map : { ...map, [key]: next };
}

/** Keeps the higher chat snapshot. A chat that ends up deleted holds no transcript. */
function withChat(s: LiveData, chat: ChatState): LiveData {
  const chats = keepHigher(s.chats, chat.id, chat);
  if (chats[chat.id]?.status.kind !== "Deleted") return { ...s, chats };
  const { [chat.id]: _, ...transcripts } = s.transcripts;
  return { ...s, chats, transcripts };
}

function withEntries(s: LiveData, chatId: ChatId, held: Record<number, EntrySnapshot>, entries: EntrySnapshot[]): LiveData {
  const transcript = entries.reduce((t, entry) => keepHigher(t, entry.seq, entry), held);
  return { ...s, transcripts: { ...s.transcripts, [chatId]: transcript } };
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
    case "ProviderChanged": {
      const { kind: _, ...state } = e;
      return { ...s, providers: keepHigher(s.providers, state.provider, state) };
    }
    case "ChatChanged": {
      const { kind: _, ...state } = e;
      return withChat(s, state);
    }
    case "ChatEntryChanged": {
      const { kind: _, ...entry } = e;
      const held = s.transcripts[entry.chatId];
      return held ? withEntries(s, entry.chatId, held, [entry]) : s;
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
  for (const p of b.providers) next = { ...next, providers: keepHigher(next.providers, p.provider, p) };
  for (const c of b.chats) next = withChat(next, c);
  return next;
}

/** `assistant_open`'s reply: the chat and every entry, by the same keep-higher rule as the events. */
export function hydrateChatLive(s: LiveData, view: ChatView): LiveData {
  const next = withChat(s, view.state);
  if (next.chats[view.state.id]?.status.kind === "Deleted") return next;
  return withEntries(next, view.state.id, next.transcripts[view.state.id] ?? {}, view.entries);
}

export const useLive = create<LiveState>()((set) => ({
  ...emptyLive,
  hydrate: (b) => set((s) => hydrateLive(s, b)),
  hydrateChat: (view) => set((s) => hydrateChatLive(s, view)),
  apply: (e) => set((s) => applyEvent(s, e)),
}));

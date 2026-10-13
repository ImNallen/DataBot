import { create } from "zustand";
import type {
  ConnectionConfig,
  ConnectionId,
  ConsoleConfigSnapshot,
  Layout,
  Settings,
  TabId,
  TabSnapshot,
  Workspace,
} from "../ipc/bindings";

export type SqlTab = { kind: "sql"; id: TabId; title: string; console: ConsoleConfigSnapshot };
export type TableTab = { kind: "table"; id: TabId; connectionId: ConnectionId; schema: string; table: string; page: number };
export type Tab = SqlTab | TableTab;

export type RelationRef = { connectionId: ConnectionId; schema: string; relation: string };

export type Overlay =
  | { kind: "none" }
  | { kind: "palette" }
  | { kind: "connection"; editing: ConnectionId | null }
  | { kind: "settings" }
  | { kind: "cell"; title: string; value: string | null }
  | { kind: "confirm"; title: string; body: string; confirmLabel: string; onConfirm: () => void };

export type WorkspaceData = {
  tabs: Record<TabId, Tab>;
  order: TabId[];
  active: TabId | null;
  layout: Layout;
  configs: Record<ConnectionId, ConnectionConfig>;
  /** Which statement's result each tab shows; absent means the last one. */
  activeResult: Record<TabId, number>;
  settings: Settings;
  /** The relation picked in the tree, shown by the Schema panel when no table tab is active. */
  selected: RelationRef | null;
  overlay: Overlay;
  toast: { id: number; text: string } | null;
  cursor: { line: number; col: number };
};

const DEFAULT_LAYOUT: Layout = { sidebar: true, results: true, rightPanel: null, resultsHeight: 320 };
const DEFAULT_SETTINGS: Settings = { maxRows: 200_000, maxResultBytes: 512 * 1024 * 1024, tablePageSize: 500, stopOnError: true };

export function tabFromSnapshot(t: TabSnapshot): Tab {
  switch (t.kind) {
    case "Sql":
      return { kind: "sql", id: t.id, title: t.title, console: t.console };
    case "Table":
      return { kind: "table", id: t.id, connectionId: t.connectionId, schema: t.schema, table: t.table, page: t.page };
    default: {
      const unreachable: never = t;
      return unreachable;
    }
  }
}

/** The persisted shape; SQL text comes from the editor states, its only owner. */
export function workspaceSnapshot(s: Pick<WorkspaceData, "tabs" | "order" | "active" | "layout">, textOf: (id: TabId) => string): Workspace {
  const tabs = s.order.flatMap((id): TabSnapshot[] => {
    const t = s.tabs[id];
    if (!t) return [];
    return t.kind === "sql"
      ? [{ kind: "Sql", id: t.id, title: t.title, text: textOf(t.id), console: t.console }]
      : [{ kind: "Table", id: t.id, connectionId: t.connectionId, schema: t.schema, table: t.table, page: t.page }];
  });
  return { tabs, active: s.active, layout: s.layout };
}

export function nextUntitled(tabs: Iterable<Tab>): string {
  let max = 0;
  for (const t of tabs) {
    const n = t.kind === "sql" ? /^Untitled-(\d+)\.sql$/.exec(t.title)?.[1] : undefined;
    if (n) max = Math.max(max, Number(n));
  }
  return `Untitled-${max + 1}.sql`;
}

export function tabLabel(tab: Tab): string {
  return tab.kind === "sql" ? tab.title : tab.table;
}

export function tabConnectionId(tab: Tab | undefined): ConnectionId | null {
  if (!tab) return null;
  return tab.kind === "sql" ? tab.console.connectionId : tab.connectionId;
}

type WorkspaceActions = {
  restore(w: Workspace, connections: ConnectionConfig[], settings: Settings): void;
  addTab(tab: Tab): void;
  closeTab(id: TabId): void;
  setActive(id: TabId): void;
  renameTab(id: TabId, title: string): void;
  patchSqlConsole(id: TabId, patch: Partial<ConsoleConfigSnapshot>): void;
  setTablePage(id: TabId, page: number): void;
  setLayout(patch: Partial<Layout>): void;
  setActiveResult(id: TabId, index: number): void;
  upsertConfig(c: ConnectionConfig): void;
  removeConfig(id: ConnectionId): void;
  setSettings(s: Settings): void;
  select(r: RelationRef | null): void;
  open(o: Overlay): void;
  close(): void;
  notify(text: string): void;
  setCursor(line: number, col: number): void;
};

let toastSeq = 0;

export const useWorkspace = create<WorkspaceData & WorkspaceActions>()((set) => ({
  tabs: {},
  order: [],
  active: null,
  layout: DEFAULT_LAYOUT,
  configs: {},
  activeResult: {},
  settings: DEFAULT_SETTINGS,
  selected: null,
  overlay: { kind: "none" },
  toast: null,
  cursor: { line: 1, col: 1 },

  restore: (w, connections, settings) => {
    const tabs = w.tabs.map(tabFromSnapshot);
    const order = tabs.map((t) => t.id);
    set({
      tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
      order,
      active: w.active && order.includes(w.active) ? w.active : (order[0] ?? null),
      layout: { ...w.layout, rightPanel: w.layout.rightPanel === "Assistant" ? "Schema" : w.layout.rightPanel },
      configs: Object.fromEntries(connections.map((c) => [c.id, c])),
      settings,
    });
  },
  addTab: (tab) => set((s) => ({ tabs: { ...s.tabs, [tab.id]: tab }, order: [...s.order, tab.id], active: tab.id })),
  closeTab: (id) =>
    set((s) => {
      const index = s.order.indexOf(id);
      const order = s.order.filter((t) => t !== id);
      const { [id]: _, ...tabs } = s.tabs;
      const { [id]: __, ...activeResult } = s.activeResult;
      const active = s.active === id ? (order[Math.min(index, order.length - 1)] ?? null) : s.active;
      return { tabs, order, active, activeResult };
    }),
  setActive: (id) => set({ active: id }),
  renameTab: (id, title) =>
    set((s) => {
      const t = s.tabs[id];
      return t?.kind === "sql" ? { tabs: { ...s.tabs, [id]: { ...t, title } } } : {};
    }),
  patchSqlConsole: (id, patch) =>
    set((s) => {
      const t = s.tabs[id];
      return t?.kind === "sql" ? { tabs: { ...s.tabs, [id]: { ...t, console: { ...t.console, ...patch } } } } : {};
    }),
  setTablePage: (id, page) =>
    set((s) => {
      const t = s.tabs[id];
      return t?.kind === "table" ? { tabs: { ...s.tabs, [id]: { ...t, page } } } : {};
    }),
  setLayout: (patch) => set((s) => ({ layout: { ...s.layout, ...patch } })),
  setActiveResult: (id, index) => set((s) => ({ activeResult: { ...s.activeResult, [id]: index } })),
  // SQL tabs opened before any connection existed bind to the first one saved.
  upsertConfig: (c) =>
    set((s) => ({
      configs: { ...s.configs, [c.id]: c },
      tabs: Object.fromEntries(
        Object.entries(s.tabs).map(([id, t]) =>
          t.kind === "sql" && t.console.connectionId === null ? [id, { ...t, console: { ...t.console, connectionId: c.id } }] : [id, t],
        ),
      ),
    })),
  removeConfig: (id) =>
    set((s) => {
      const { [id]: _, ...configs } = s.configs;
      return { configs };
    }),
  setSettings: (settings) => set({ settings }),
  select: (selected) => set({ selected }),
  open: (overlay) => set({ overlay }),
  close: () => set({ overlay: { kind: "none" } }),
  notify: (text) => set({ toast: { id: ++toastSeq, text } }),
  setCursor: (line, col) => set({ cursor: { line, col } }),
}));

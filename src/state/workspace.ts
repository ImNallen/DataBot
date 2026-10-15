import { create } from "zustand";
import type {
  ConnectionConfig,
  ConnectionId,
  DatabaseRef,
  Layout,
  Settings,
  TabId,
  TableQuery,
  TabSnapshot,
  TxnMode,
  Workspace,
} from "../ipc/bindings";
import type { SettingId, SettingsSectionId } from "../features/settings/sections";
import { homeDb, sameDb } from "./dbKey";
import type { ResultPick } from "./status";

/** A tab's console target. A tab never names a connection without a database. */
export type ConsoleTarget = { db: DatabaseRef | null; mode: TxnMode };

export type SqlTab = { kind: "sql"; id: TabId; title: string; console: ConsoleTarget };
export type TableTab = {
  kind: "table";
  id: TabId;
  db: DatabaseRef;
  schema: string;
  table: string;
  page: number;
  query: TableQuery;
  exactRowCount?: number;
};

export const EMPTY_QUERY: TableQuery = { orderBy: "", filters: [], where: "" };

export function isFiltered(q: TableQuery): boolean {
  return q.filters.length > 0 || q.where.trim() !== "";
}
export type Tab = SqlTab | TableTab;

export type RelationRef = { db: DatabaseRef; schema: string; relation: string };

export type Overlay =
  | { kind: "none" }
  | { kind: "palette" }
  | { kind: "history" }
  | { kind: "settings-search" }
  | { kind: "connection"; editing: ConnectionId | null }
  | { kind: "cell"; title: string; value: string | null }
  | { kind: "confirm"; title: string; body: string; confirmLabel: string; onConfirm: () => void };

export type Screen = { kind: "workspace" } | { kind: "settings"; section: SettingsSectionId; target?: SettingId };

export type WorkspaceData = {
  tabs: Record<TabId, Tab>;
  order: TabId[];
  active: TabId | null;
  layout: Layout;
  configs: Record<ConnectionId, ConnectionConfig>;
  activeResult: Record<TabId, ResultPick>;
  settings: Settings;
  selected: RelationRef | null;
  overlay: Overlay;
  screen: Screen;
  toast: { id: number; text: string } | null;
  cursor: { line: number; col: number };
};

const DEFAULT_LAYOUT: Layout = { sidebar: true, results: true, rightPanel: null, resultsHeight: 320, sidebarWidth: 256, rightPanelWidth: 341 };
export const DEFAULT_SETTINGS: Settings = {
  maxRows: 200_000,
  maxResultBytes: 512 * 1024 * 1024,
  tablePageSize: 500,
  stopOnError: true,
  colorScheme: "System",
  lightTheme: "l1-light",
  darkTheme: "l1-dark",
  customThemes: [],
  interfaceFont: { family: "Inter", size: 13 },
  codeFont: { family: "JetBrains Mono", size: 13 },
  density: "Standard",
  panelMotionMs: 150,
};

/**
 * A tab saved before tabs carried a database (`database: null`) resolves to the connection's
 * configured database, the only one it could have used. A tab whose connection is gone loses its
 * target: a SQL tab keeps its text, a table tab can never run again and is dropped.
 */
export function tabFromSnapshot(t: TabSnapshot, configs: Record<ConnectionId, ConnectionConfig>): Tab | null {
  const resolve = (connectionId: ConnectionId | null, database: string | null | undefined): DatabaseRef | null => {
    const config = connectionId ? configs[connectionId] : undefined;
    if (!config) return null;
    return database == null ? homeDb(config) : { connectionId: config.id, database };
  };
  switch (t.kind) {
    case "Sql":
      return { kind: "sql", id: t.id, title: t.title, console: { db: resolve(t.console.connectionId, t.console.database), mode: t.console.mode } };
    case "Table": {
      const db = resolve(t.connectionId, t.database);
      return db && { kind: "table", id: t.id, db, schema: t.schema, table: t.table, page: t.page, query: t.query ?? EMPTY_QUERY };
    }
    default: {
      const unreachable: never = t;
      return unreachable;
    }
  }
}

export function workspaceSnapshot(s: Pick<WorkspaceData, "tabs" | "order" | "active" | "layout">, textOf: (id: TabId) => string): Workspace {
  const tabs = s.order.flatMap((id): TabSnapshot[] => {
    const t = s.tabs[id];
    if (!t) return [];
    return t.kind === "sql"
      ? [
          {
            kind: "Sql",
            id: t.id,
            title: t.title,
            text: textOf(t.id),
            console: { connectionId: t.console.db?.connectionId ?? null, database: t.console.db?.database ?? null, schema: null, mode: t.console.mode },
          },
        ]
      : [{ kind: "Table", id: t.id, connectionId: t.db.connectionId, database: t.db.database, schema: t.schema, table: t.table, page: t.page, query: t.query }];
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

export function tabTarget(tab: Tab | undefined): DatabaseRef | null {
  if (!tab) return null;
  return tab.kind === "sql" ? tab.console.db : tab.db;
}

/** A table tab has no mode of its own. Its browse runs and staged edits always auto-commit. */
export function tabMode(tab: Tab): TxnMode {
  return tab.kind === "sql" ? tab.console.mode : "AutoCommit";
}

type WorkspaceActions = {
  restore(w: Workspace, connections: ConnectionConfig[], settings: Settings): void;
  addTab(tab: Tab): void;
  closeTab(id: TabId): void;
  setActive(id: TabId): void;
  renameTab(id: TabId, title: string): void;
  patchSqlConsole(id: TabId, patch: Partial<ConsoleTarget>): void;
  setTablePage(id: TabId, page: number, exactRowCount?: number): void;
  setTableQuery(id: TabId, query: TableQuery): void;
  setLayout(patch: Partial<Layout>): void;
  setActiveResult(id: TabId, pick: ResultPick): void;
  upsertConfig(c: ConnectionConfig): void;
  removeConfig(id: ConnectionId): void;
  setSettings(s: Settings): void;
  select(r: RelationRef | null): void;
  open(o: Overlay): void;
  close(): void;
  openSettings(section?: SettingsSectionId, target?: SettingId): void;
  closeSettings(): void;
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
  screen: { kind: "workspace" },
  toast: null,
  cursor: { line: 1, col: 1 },

  restore: (w, connections, settings) => {
    const configs = Object.fromEntries(connections.map((c) => [c.id, c]));
    const tabs = w.tabs.flatMap((t) => tabFromSnapshot(t, configs) ?? []);
    const order = tabs.map((t) => t.id);
    set({
      tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
      order,
      active: w.active && order.includes(w.active) ? w.active : (order[0] ?? null),
      layout: { ...w.layout, rightPanel: w.layout.rightPanel && "Assistant" },
      configs,
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
  setTablePage: (id, page, exactRowCount) =>
    set((s) => {
      const t = s.tabs[id];
      return t?.kind === "table" ? { tabs: { ...s.tabs, [id]: { ...t, page, ...(exactRowCount !== undefined && { exactRowCount }) } } } : {};
    }),
  setTableQuery: (id, query) =>
    set((s) => {
      const t = s.tabs[id];
      return t?.kind === "table" ? { tabs: { ...s.tabs, [id]: { ...t, query, page: 0, exactRowCount: undefined } } } : {};
    }),
  setLayout: (patch) => set((s) => ({ layout: { ...s.layout, ...patch } })),
  setActiveResult: (id, pick) => set((s) => ({ activeResult: { ...s.activeResult, [id]: pick } })),
  upsertConfig: (c) =>
    set((s) => {
      const previous = s.configs[c.id];
      // A SQL tab on the connection's configured database follows an edit of that database. A
      // table tab names the database its table lives in and stays.
      const follows = (db: DatabaseRef | null) =>
        db === null || (previous !== undefined && previous.database !== c.database && sameDb(db, homeDb(previous)));
      return {
        configs: { ...s.configs, [c.id]: c },
        tabs: Object.fromEntries(
          Object.entries(s.tabs).map(([id, t]) => (t.kind === "sql" && follows(t.console.db) ? [id, { ...t, console: { ...t.console, db: homeDb(c) } }] : [id, t])),
        ),
      };
    }),
  removeConfig: (id) =>
    set((s) => {
      const { [id]: _, ...configs } = s.configs;
      return { configs };
    }),
  setSettings: (settings) => set({ settings }),
  select: (selected) => set({ selected }),
  open: (overlay) => set({ overlay }),
  close: () => set({ overlay: { kind: "none" } }),
  openSettings: (section = "appearance", target) => set({ screen: { kind: "settings", section, target }, overlay: { kind: "none" } }),
  closeSettings: () => set({ screen: { kind: "workspace" }, overlay: { kind: "none" } }),
  notify: (text) => set({ toast: { id: ++toastSeq, text } }),
  setCursor: (line, col) => set({ cursor: { line, col } }),
}));

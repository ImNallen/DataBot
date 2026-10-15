import { describe, expect, it } from "vitest";
import type { ConnectionConfig } from "../ipc/bindings";
import { EMPTY_QUERY, useWorkspace } from "./workspace";

const config = (id: string): ConnectionConfig => ({
  id,
  name: id,
  host: "localhost",
  port: 5433,
  database: "shop",
  user: "l1data",
  sslMode: "Prefer",
  caCertPath: null,
  hasPassword: true,
  color: null,
});

describe("workspace.upsertConfig", () => {
  it("binds SQL tabs that have no connection and leaves bound tabs alone", () => {
    const ws = useWorkspace.getState();
    ws.addTab({ kind: "sql", id: "free", title: "Untitled-1.sql", console: { db: null, mode: "AutoCommit" } });
    ws.addTab({ kind: "sql", id: "bound", title: "Untitled-2.sql", console: { db: { connectionId: "old", database: "reporting" }, mode: "Manual" } });
    ws.upsertConfig(config("new"));
    const tabs = useWorkspace.getState().tabs;
    expect(tabs.free?.kind === "sql" && tabs.free.console.db).toEqual({ connectionId: "new", database: "shop" });
    expect(tabs.bound?.kind === "sql" && tabs.bound.console.db).toEqual({ connectionId: "old", database: "reporting" });
  });

  it("moves SQL tabs on the connection's configured database when that database is edited", () => {
    const ws = useWorkspace.getState();
    ws.upsertConfig(config("edited"));
    ws.addTab({ kind: "sql", id: "home", title: "a.sql", console: { db: { connectionId: "edited", database: "shop" }, mode: "AutoCommit" } });
    ws.addTab({ kind: "sql", id: "elsewhere", title: "b.sql", console: { db: { connectionId: "edited", database: "reporting" }, mode: "AutoCommit" } });
    ws.addTab({ kind: "sql", id: "otherConn", title: "c.sql", console: { db: { connectionId: "other", database: "shop" }, mode: "AutoCommit" } });
    ws.addTab({ kind: "table", id: "orders", db: { connectionId: "edited", database: "shop" }, schema: "public", table: "orders", page: 0, query: EMPTY_QUERY });
    ws.upsertConfig({ ...config("edited"), database: "shop_v2" });
    const target = (id: string) => {
      const t = useWorkspace.getState().tabs[id]!;
      return t.kind === "sql" ? t.console.db : t.db;
    };
    expect(target("home")).toEqual({ connectionId: "edited", database: "shop_v2" });
    expect(target("elsewhere")).toEqual({ connectionId: "edited", database: "reporting" });
    expect(target("otherConn")).toEqual({ connectionId: "other", database: "shop" });
    expect(target("orders")).toEqual({ connectionId: "edited", database: "shop" });
    ws.upsertConfig({ ...config("edited"), database: "shop_v2", name: "renamed" });
    expect(target("home")).toEqual({ connectionId: "edited", database: "shop_v2" });
  });
});

describe("workspace.restore", () => {
  it("reopens a saved right panel as the Assistant, whichever panel was saved", () => {
    const { settings } = useWorkspace.getState();
    const layout = { sidebar: true, results: true, resultsHeight: 320, sidebarWidth: 256, rightPanelWidth: 341 };
    for (const saved of ["History", "Schema", "Assistant"] as const) {
      useWorkspace.getState().restore({ tabs: [], active: null, layout: { ...layout, rightPanel: saved } }, [], settings);
      expect(useWorkspace.getState().layout.rightPanel).toBe("Assistant");
    }
    useWorkspace.getState().restore({ tabs: [], active: null, layout: { ...layout, rightPanel: null } }, [], settings);
    expect(useWorkspace.getState().layout.rightPanel).toBeNull();
  });
});

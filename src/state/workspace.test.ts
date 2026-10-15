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
  it("binds tabs that have no connection and leaves bound tabs alone", () => {
    const ws = useWorkspace.getState();
    ws.addTab({ id: "free", title: "Untitled-1.sql", console: { db: null, mode: "AutoCommit" }, table: null });
    ws.addTab({ id: "bound", title: "Untitled-2.sql", console: { db: { connectionId: "old", database: "reporting" }, mode: "Manual" }, table: null });
    ws.upsertConfig(config("new"));
    const tabs = useWorkspace.getState().tabs;
    expect(tabs.free?.console.db).toEqual({ connectionId: "new", database: "shop" });
    expect(tabs.bound?.console.db).toEqual({ connectionId: "old", database: "reporting" });
  });

  it("moves query tabs on the connection's configured database when that database is edited, but not table tabs", () => {
    const ws = useWorkspace.getState();
    ws.upsertConfig(config("edited"));
    const tab = (id: string, title: string, database: string, connectionId = "edited") =>
      ws.addTab({ id, title, console: { db: { connectionId, database }, mode: "AutoCommit" }, table: null });
    tab("home", "a.sql", "shop");
    tab("elsewhere", "b.sql", "reporting");
    tab("otherConn", "c.sql", "shop", "other");
    ws.addTab({
      id: "orders",
      title: "orders",
      console: { db: { connectionId: "edited", database: "shop" }, mode: "AutoCommit" },
      table: { schema: "public", table: "orders", page: 0, query: EMPTY_QUERY },
    });
    ws.upsertConfig({ ...config("edited"), database: "shop_v2" });
    const target = (id: string) => useWorkspace.getState().tabs[id]!.console.db;
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

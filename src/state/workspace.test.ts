import { describe, expect, it } from "vitest";
import type { ConnectionConfig } from "../ipc/bindings";
import { useWorkspace } from "./workspace";

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
    ws.addTab({ kind: "sql", id: "free", title: "Untitled-1.sql", console: { connectionId: null, schema: "public", mode: "AutoCommit" } });
    ws.addTab({ kind: "sql", id: "bound", title: "Untitled-2.sql", console: { connectionId: "old", schema: "public", mode: "Manual" } });
    ws.upsertConfig(config("new"));
    const tabs = useWorkspace.getState().tabs;
    expect(tabs.free?.kind === "sql" && tabs.free.console.connectionId).toBe("new");
    expect(tabs.bound?.kind === "sql" && tabs.bound.console.connectionId).toBe("old");
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

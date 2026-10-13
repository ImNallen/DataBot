import { describe, expect, it } from "vitest";
import type { ConnectionConfig } from "../ipc/bindings";
import { useWorkspace } from "./workspace";

const config = (id: string): ConnectionConfig => ({
  id,
  name: id,
  host: "localhost",
  port: 5433,
  database: "shop",
  user: "databot",
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

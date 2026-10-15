import { mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, expect, it, vi } from "vitest";
import type { HistoryGroupSummary } from "../../ipc/bindings";
import { useLive } from "../../state/live";
import { useWorkspace } from "../../state/workspace";
import { dropEditor, textOf } from "../editor/editorStates";
import { openSqlTab, openTableTab } from "../editor/runActions";
import { insertHistoryQuery, openHistoryQuery } from "./historyActions";

const group: HistoryGroupSummary = {
  id: 1, latestId: 3, latestAtMs: 123, connectionId: "saved-connection", database: "reporting", title: "Revenue", excerpt: "select 42",
  runCount: 3, failedCount: 0, isWrite: false,
  representative: { id: 3, atMs: 123, connectionName: "dev", elapsedMs: 20, outcome: { kind: "Rows", rows: 1 } },
};
afterEach(() => {
  for (const id of useWorkspace.getState().order) dropEditor(id);
  useWorkspace.setState(useWorkspace.getInitialState(), true);
  useLive.setState(useLive.getInitialState(), true);
  vi.unstubAllGlobals();
});

it("opens the exact saved SQL and database in a new tab without changing the original editor", () => {
  const original = openSqlTab({ text: "select 'untouched'" });
  openHistoryQuery(group, "-- Revenue\nselect 42");
  const ws = useWorkspace.getState();
  const tab = ws.active ? ws.tabs[ws.active] : undefined;
  expect(tab).toMatchObject({ title: "Revenue", console: { db: { connectionId: "saved-connection", database: "reporting" } }, table: null });
  expect(tab && textOf(tab.id)).toBe("-- Revenue\nselect 42");
  expect(textOf(original)).toBe("select 'untouched'");
});

it("inserts at the cursor of the active tab's editor, a table tab's too, and needs an open tab", () => {
  expect(insertHistoryQuery("select 42")).toBe(false);
  openTableTab({ db: { connectionId: "c1", database: "shop" }, schema: "public", relation: "orders" });
  const tableId = useWorkspace.getState().active!;
  expect(insertHistoryQuery("select 42;\n")).toBe(true);
  expect(textOf(tableId)).toBe("select 42;\nSELECT * FROM public.orders");
  const id = openSqlTab({ text: "select 1;" });
  expect(insertHistoryQuery("select 42;\n")).toBe(true);
  expect(textOf(id)).toBe("select 42;\nselect 1;");
});

it("runs a new tab through console configuration against the recorded database", async () => {
  vi.stubGlobal("window", { crypto });
  const calls: { cmd: string; args: unknown }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "console_configure") return null;
    if (cmd === "console_run") return { runId: 1, statements: [] };
  });
  openHistoryQuery(group, "select 42", true);
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[0]).toMatchObject({ cmd: "console_configure", args: { config: { connectionId: "saved-connection", database: "reporting", mode: "AutoCommit" } } });
  expect(calls[1]).toMatchObject({ cmd: "console_run", args: { request: { kind: "script", text: "select 42" } } });
});

it("shows the existing configure error when a saved connection was removed", async () => {
  vi.stubGlobal("window", { crypto });
  mockIPC((cmd) => { if (cmd === "console_configure") throw { kind: "UnknownConnection" }; });
  openHistoryQuery(group, "select 42", true);
  await vi.waitFor(() => expect(useWorkspace.getState().toast?.text).toBe("That connection no longer exists."));
});

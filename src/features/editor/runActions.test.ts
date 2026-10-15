import { mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, expect, it, vi } from "vitest";
import type { ConsoleState, Settings } from "../../ipc/bindings";
import { useLive } from "../../state/live";
import { useTableEdits } from "../../state/tableEdits";
import { useWorkspace } from "../../state/workspace";
import { dropEditor } from "./editorStates";
import { browseQuery, openTableTab, saveSettings, setTabMode, setTabTarget } from "./runActions";

afterEach(() => {
  vi.unstubAllGlobals();
  for (const id of useWorkspace.getState().order) dropEditor(id);
  useWorkspace.setState(useWorkspace.getInitialState(), true);
  useLive.setState(useLive.getInitialState(), true);
  useTableEdits.setState(useTableEdits.getInitialState(), true);
});

const orders = { db: { connectionId: "c1", database: "shop" }, schema: "public", relation: "orders" };

it("quotes only the identifiers that need it in a table's browse query", () => {
  expect(browseQuery("public", "customers")).toBe("SELECT * FROM public.customers");
  expect(browseQuery("public", "order")).toBe('SELECT * FROM public."order"');
  expect(browseQuery("Sales", "line items")).toBe('SELECT * FROM "Sales"."line items"');
  expect(browseQuery("public", 'say "hi"')).toBe('SELECT * FROM public."say ""hi"""');
});

it("opens the results when a table opens, new or already in a tab", () => {
  const ref = { db: { connectionId: "c1", database: "shop" }, schema: "public", relation: "orders" };
  useWorkspace.setState({ layout: { ...useWorkspace.getState().layout, results: false } });
  openTableTab(ref);
  const tab = useWorkspace.getState().tabs[useWorkspace.getState().active!];
  expect([tab, useWorkspace.getState().layout.results]).toEqual([
    {
      id: tab?.id,
      title: "orders",
      console: { db: { connectionId: "c1", database: "shop" }, mode: "AutoCommit" },
      table: { schema: "public", table: "orders", page: 0, query: { orderBy: "", filters: [], where: "" } },
    },
    true,
  ]);

  useWorkspace.setState({ layout: { ...useWorkspace.getState().layout, results: false } });
  openTableTab(ref);
  expect(Object.keys(useWorkspace.getState().tabs)).toHaveLength(1);
  expect(useWorkspace.getState().layout.results).toBe(true);
});

it("writes settings one at a time, so the write that lands last carries every change", async () => {
  vi.stubGlobal("window", { crypto });
  const pending: { settings: Settings; finish: () => void }[] = [];
  let inFlight = 0;
  let overlapped = false;
  let persisted: Settings | null = null;
  mockIPC((cmd, args) => {
    if (cmd !== "settings_set") return;
    const { settings } = args as { settings: Settings };
    overlapped ||= ++inFlight > 1;
    return new Promise<void>((resolve) =>
      pending.push({
        settings,
        finish: () => {
          inFlight--;
          persisted = settings;
          resolve();
        },
      }),
    );
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));

  const saves = Promise.all([saveSettings({ maxRows: 5 }), saveSettings({ colorScheme: "Dark" })]);
  for (await flush(); pending.length > 0; await flush()) pending.pop()!.finish();
  await saves;

  expect({ overlapped, persisted }).toMatchObject({ overlapped: false, persisted: { maxRows: 5, colorScheme: "Dark" } });
});

function openWithConsole(mode: "AutoCommit" | "Manual" = "AutoCommit") {
  openTableTab(orders);
  const id = useWorkspace.getState().active!;
  const console: ConsoleState = {
    tabId: id,
    rev: 1,
    config: { connectionId: "c1", database: "shop", schema: null, mode },
    session: { kind: "None" },
    txn: "Idle",
    run: { kind: "Idle" },
  };
  useLive.setState({ consoles: { [id]: console } });
  return id;
}

it("switches a table tab to manual transactions through console_configure", async () => {
  vi.stubGlobal("window", { crypto });
  const calls: { cmd: string; args: unknown }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    return null;
  });
  const id = openWithConsole();
  await setTabMode(id, "Manual");
  expect(calls).toEqual([
    { cmd: "console_configure", args: { tabId: id, config: { connectionId: "c1", database: "shop", schema: null, mode: "Manual" } } },
  ]);
  expect(useWorkspace.getState().tabs[id]?.console.mode).toBe("Manual");
});

it("keeps a tab on its database while it has staged edits", async () => {
  vi.stubGlobal("window", { crypto });
  const calls: string[] = [];
  mockIPC((cmd) => {
    calls.push(cmd);
    return null;
  });
  const id = openWithConsole();
  useTableEdits.getState().addRow(id);
  await setTabTarget(id, { connectionId: "c1", database: "reporting" });
  expect([calls, useWorkspace.getState().tabs[id]?.console.db, useWorkspace.getState().toast?.text]).toEqual([
    [],
    { connectionId: "c1", database: "shop" },
    "Submit or revert the pending changes first.",
  ]);

  useTableEdits.getState().clear(id);
  await setTabTarget(id, { connectionId: "c1", database: "reporting" });
  expect([calls, useWorkspace.getState().tabs[id]?.console.db]).toEqual([["console_configure"], { connectionId: "c1", database: "reporting" }]);
});

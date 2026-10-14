import { mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, expect, it, vi } from "vitest";
import type { Settings } from "../../ipc/bindings";
import { useWorkspace } from "../../state/workspace";
import { browseQuery, openTableTab, saveSettings } from "./runActions";

afterEach(() => {
  vi.unstubAllGlobals();
  useWorkspace.setState(useWorkspace.getInitialState(), true);
});

it("quotes only the identifiers that need it in a table's browse query", () => {
  expect(browseQuery("public", "customers")).toBe("SELECT * FROM public.customers");
  expect(browseQuery("public", "order")).toBe('SELECT * FROM public."order"');
  expect(browseQuery("Sales", "line items")).toBe('SELECT * FROM "Sales"."line items"');
  expect(browseQuery("public", 'say "hi"')).toBe('SELECT * FROM public."say ""hi"""');
});

it("opens the results when a table opens, new or already in a tab", () => {
  const ref = { connectionId: "c1", schema: "public", relation: "orders" };
  useWorkspace.setState({ layout: { ...useWorkspace.getState().layout, results: false } });
  openTableTab(ref);
  const tab = useWorkspace.getState().tabs[useWorkspace.getState().active!];
  expect([tab?.kind, useWorkspace.getState().layout.results]).toEqual(["table", true]);

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

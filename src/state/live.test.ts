import { describe, expect, it } from "vitest";
import type { AppEvent, BootSnapshot, ConsoleState, OutputEntry } from "../ipc/bindings";
import { applyEvent, emptyLive, hydrateLive, OUTPUT_LIMIT } from "./live";

const CONN = "c0000000-0000-4000-8000-000000000001";
const TAB = "t0000000-0000-4000-8000-000000000001";

function consoleAt(rev: number, txn: ConsoleState["txn"] = "Idle"): ConsoleState {
  return {
    tabId: TAB,
    rev,
    config: { connectionId: CONN, schema: "public", mode: "Manual" },
    session: { kind: "None" },
    txn,
    run: { kind: "Idle" },
  };
}

const consoleChanged = (c: ConsoleState): AppEvent => ({ kind: "ConsoleChanged", ...c });

describe("live.apply", () => {
  it("keeps the higher rev regardless of arrival order", () => {
    const inOrder = [consoleAt(1), consoleAt(2, "Active")].reduce((s, c) => applyEvent(s, consoleChanged(c)), emptyLive);
    const reversed = [consoleAt(2, "Active"), consoleAt(1)].reduce((s, c) => applyEvent(s, consoleChanged(c)), emptyLive);
    expect(inOrder.consoles[TAB]?.txn).toBe("Active");
    expect(reversed.consoles[TAB]?.txn).toBe("Active");
    expect(reversed.consoles[TAB]?.rev).toBe(2);
  });

  it("is idempotent for a replayed snapshot", () => {
    const once = applyEvent(emptyLive, consoleChanged(consoleAt(3, "Active")));
    expect(applyEvent(once, consoleChanged(consoleAt(3, "Active")))).toEqual(once);
  });

  it("strips the event tag so the stored value is the contract's ConsoleState", () => {
    const s = applyEvent(emptyLive, consoleChanged(consoleAt(1)));
    expect(s.consoles[TAB]).toEqual(consoleAt(1));
  });

  it("an event that raced the boot snapshot survives hydrate when it is newer", () => {
    const early = applyEvent(emptyLive, {
      kind: "ConnectionChanged",
      id: CONN,
      rev: 9,
      status: { kind: "Connected", server: { version: "16.4", versionNum: 160004, encoding: "UTF8" }, catalogVersion: 2 },
    });
    const boot: BootSnapshot = {
      connections: [],
      live: [{ id: CONN, rev: 4, status: { kind: "Connecting" } }],
      consoles: [consoleAt(1)],
      workspace: { tabs: [], active: null, layout: { sidebar: true, results: true, rightPanel: null, resultsHeight: 320, sidebarWidth: 256, rightPanelWidth: 341 } },
      settings: { maxRows: 1, maxResultBytes: 1, tablePageSize: 1, stopOnError: true, colorScheme: "System", lightTheme: "l1-light", darkTheme: "l1-dark", customThemes: [] },
    };
    const s = hydrateLive(early, boot);
    expect(s.connections[CONN]?.status.kind).toBe("Connected");
    expect(s.catalogVersions[CONN]).toBe(2);
    expect(s.consoles[TAB]?.rev).toBe(1);
  });

  it("tracks the highest catalog version from CatalogChanged and Connected", () => {
    let s = applyEvent(emptyLive, { kind: "CatalogChanged", connectionId: CONN, version: 5 });
    s = applyEvent(s, { kind: "CatalogChanged", connectionId: CONN, version: 3 });
    expect(s.catalogVersions[CONN]).toBe(5);
  });

  it("appends output and caps it per tab", () => {
    const entry = (n: number): OutputEntry => ({ atMs: n, runId: 1, body: { kind: "Info", message: `m${n}` } });
    let s = applyEvent(emptyLive, { kind: "ConsoleOutput", tabId: TAB, entries: [entry(0), entry(1)] });
    s = applyEvent(s, { kind: "ConsoleOutput", tabId: TAB, entries: Array.from({ length: OUTPUT_LIMIT }, (_, i) => entry(i + 2)) });
    const out = s.output[TAB]!;
    expect(out).toHaveLength(OUTPUT_LIMIT);
    expect(out[0]?.atMs).toBe(2);
    expect(out.at(-1)?.atMs).toBe(OUTPUT_LIMIT + 1);
  });

  it("prepends appended history entries", () => {
    const base = { atMs: 0, connectionId: CONN, connectionName: "p", database: "shop", sql: "select 1", elapsedMs: 1, outcome: { kind: "Cancelled" as const } };
    let s = applyEvent(emptyLive, { kind: "HistoryAppended", id: 1, ...base });
    s = applyEvent(s, { kind: "HistoryAppended", id: 2, ...base });
    expect(s.historyTail.map((h) => h.id)).toEqual([2, 1]);
  });
});

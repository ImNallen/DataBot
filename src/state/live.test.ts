import { describe, expect, it } from "vitest";
import type { AppEvent, BootSnapshot, ConnectionState, ConsoleState, DatabaseState, OutputEntry } from "../ipc/bindings";
import { applyEvent, emptyLive, hydrateLive, OUTPUT_LIMIT, wantedCatalogs } from "./live";

const CONN = "c0000000-0000-4000-8000-000000000001";
const TAB = "t0000000-0000-4000-8000-000000000001";

function consoleAt(rev: number, txn: ConsoleState["txn"] = "Idle"): ConsoleState {
  return {
    tabId: TAB,
    rev,
    config: { connectionId: CONN, database: "shop", schema: "public", mode: "Manual" },
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
      status: { kind: "Connected", server: { version: "16.4", versionNum: 160004, encoding: "UTF8" }, instance: { home: "shop", databases: [] } },
    });
    const boot: BootSnapshot = {
      connections: [],
      live: [{ id: CONN, rev: 4, status: { kind: "Connecting" } }],
      consoles: [consoleAt(1)],
      workspace: { tabs: [], active: null, layout: { sidebar: true, results: true, rightPanel: null, resultsHeight: 320, sidebarWidth: 256, rightPanelWidth: 341 } },
      settings: { maxRows: 1, maxResultBytes: 1, tablePageSize: 1, stopOnError: true, colorScheme: "System", lightTheme: "l1-light", darkTheme: "l1-dark", customThemes: [], interfaceFont: { family: "Inter", size: 13 }, codeFont: { family: "JetBrains Mono", size: 13 }, density: "Standard", panelMotionMs: 150 },
    };
    const s = hydrateLive(early, boot);
    expect(s.connections[CONN]?.status.kind).toBe("Connected");
    expect(s.consoles[TAB]?.rev).toBe(1);
  });

  it("wants the Ready catalogs of connected instances and the last good one behind a failed reload", () => {
    const db = (name: string, catalog: DatabaseState["catalog"]): DatabaseState => ({ name, system: false, access: "Ok", shown: name === "shop", catalog });
    const server = { version: "16.4", versionNum: 160004, encoding: "UTF8" };
    const connections: Record<string, ConnectionState> = {
      [CONN]: {
        id: CONN,
        rev: 3,
        status: {
          kind: "Connected",
          server,
          instance: {
            home: "shop",
            databases: [
              db("postgres", { kind: "Idle" }),
              db("reporting", { kind: "Ready", version: 7 }),
              db("shop", { kind: "Loading" }),
              db("stale", { kind: "Failed", message: "statement timeout", version: 5 }),
              db("never", { kind: "Failed", message: "permission denied", version: null }),
            ],
          },
        },
      },
      other: { id: "other", rev: 1, status: { kind: "Connected", server, instance: { home: "x", databases: [db("x", { kind: "Ready", version: 2 })] } } },
      down: { id: "down", rev: 9, status: { kind: "Lost", reason: "gone" } },
    };
    expect([...wantedCatalogs(connections).entries()]).toEqual([
      [`${CONN}\u0000reporting`, { ref: { connectionId: CONN, database: "reporting" }, version: 7 }],
      [`${CONN}\u0000stale`, { ref: { connectionId: CONN, database: "stale" }, version: 5 }],
      ["other\u0000x", { ref: { connectionId: "other", database: "x" }, version: 2 }],
    ]);
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

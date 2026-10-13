import { describe, expect, it } from "vitest";
import type { ConsoleState, ResultMeta, RunState, StatementRun } from "../ipc/bindings";
import { hasUncommittedWork, rowResults, runSummary, shownResult } from "./status";
import { nextUntitled, tabFromSnapshot, workspaceSnapshot, type Tab } from "./workspace";

const meta = (index: number, rowCount: number, extra: Partial<ResultMeta> = {}): ResultMeta => ({
  ref: { tabId: "t", runId: 1, index },
  columns: [],
  rowCount,
  rowsSeen: rowCount,
  truncated: null,
  elapsedMs: 38,
  ...extra,
});
const stmt = (index: number, status: StatementRun["status"]): StatementRun => ({ index, range: { from: 0, to: 1 }, status });
const finished = (statements: StatementRun[], outcome: "Ok" | "Failed" | "Cancelled" = "Ok"): RunState => ({
  kind: "Finished",
  runId: 1,
  elapsedMs: 50,
  statements,
  outcome,
});

function consoleWith(mode: "AutoCommit" | "Manual", txn: ConsoleState["txn"]): ConsoleState {
  return { tabId: "t", rev: 1, config: { connectionId: "c", schema: null, mode }, session: { kind: "None" }, txn, run: { kind: "Idle" } };
}

describe("hasUncommittedWork", () => {
  it("is true only for a manual console holding a transaction", () => {
    expect(hasUncommittedWork(consoleWith("Manual", "Active"))).toBe(true);
    expect(hasUncommittedWork(consoleWith("Manual", "Aborted"))).toBe(true);
    expect(hasUncommittedWork(consoleWith("Manual", "Idle"))).toBe(false);
    expect(hasUncommittedWork(consoleWith("AutoCommit", "Active"))).toBe(false);
    expect(hasUncommittedWork(undefined)).toBe(false);
  });
});

describe("runSummary", () => {
  it("reads like the mockup for a finished row result", () => {
    expect(runSummary(finished([stmt(0, { kind: "Rows", result: meta(0, 6), done: true })]), undefined, 0)).toEqual({
      tone: "ok",
      text: "6 rows · 38 ms",
    });
  });

  it("names a truncated result's limit and the rows the server sent", () => {
    const run = finished([stmt(0, { kind: "Rows", result: meta(0, 200_000, { rowsSeen: 300_000, truncated: "RowLimit" }), done: true })]);
    expect(runSummary(run, undefined, 0)?.text).toBe("200,000 of 300,000 rows (row limit) · 38 ms");
  });

  it("shows the first error of a failed run", () => {
    const error = { severity: "ERROR", sqlstate: "42P01", message: 'relation "nope" does not exist', detail: null, hint: null, context: null, position: 14 };
    expect(runSummary(finished([stmt(0, { kind: "Failed", error })], "Failed"), undefined, 0)).toEqual({ tone: "error", text: error.message });
  });

  it("falls back to the last command tag when no statement returned rows", () => {
    const run = finished([stmt(0, { kind: "Command", tag: "UPDATE 3", elapsedMs: 4 })]);
    expect(runSummary(run, undefined, 0)?.text).toBe("UPDATE 3 · 4 ms");
  });

  it("counts elapsed time from startedAtMs while running", () => {
    const run: RunState = { kind: "Running", runId: 1, startedAtMs: 1_000, statements: [stmt(0, { kind: "Preparing" })] };
    expect(runSummary(run, undefined, 3_500)).toEqual({ tone: "running", text: "Running · 2.50 s" });
  });
});

describe("shownResult", () => {
  const run = finished([
    stmt(0, { kind: "Rows", result: meta(0, 1), done: true }),
    stmt(1, { kind: "Command", tag: "UPDATE 1", elapsedMs: 1 }),
    stmt(2, { kind: "Rows", result: meta(2, 9), done: true }),
  ]);

  it("defaults to the last row result and honours a pick that still exists", () => {
    expect(rowResults(run).map((r) => r.index)).toEqual([0, 2]);
    expect(shownResult(run, undefined)?.index).toBe(2);
    expect(shownResult(run, 0)?.index).toBe(0);
    expect(shownResult(run, 1)?.index).toBe(2);
  });
});

describe("workspace snapshot", () => {
  const tabs: Tab[] = [
    { kind: "sql", id: "a", title: "Untitled-2.sql", console: { connectionId: "c", schema: null, mode: "Manual" } },
    { kind: "table", id: "b", connectionId: "c", schema: "public", table: "orders", page: 3 },
  ];
  const state = {
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    order: ["b", "a"],
    active: "a",
    layout: { sidebar: true, results: false, rightPanel: "History" as const, resultsHeight: 280, sidebarWidth: 256, rightPanelWidth: 341 },
  };

  it("round-trips tabs in order with text read from the editor", () => {
    const snap = workspaceSnapshot(state, (id) => `-- text of ${id}`);
    expect(snap.tabs.map((t) => t.id)).toEqual(["b", "a"]);
    expect(snap.tabs[1]).toMatchObject({ kind: "Sql", text: "-- text of a", console: { mode: "Manual" } });
    expect(snap.tabs.map(tabFromSnapshot)).toEqual([tabs[1], tabs[0]]);
    expect(snap.layout).toEqual(state.layout);
  });

  it("drops the per-tab schema saved by older versions, since consoles span the whole database", () => {
    const old = { kind: "Sql" as const, id: "a", title: "q.sql", text: "", console: { connectionId: "c", schema: "lab", mode: "AutoCommit" as const } };
    expect(tabFromSnapshot(old)).toEqual({ kind: "sql", id: "a", title: "q.sql", console: { connectionId: "c", schema: null, mode: "AutoCommit" } });
  });

  it("numbers new tabs after the highest Untitled", () => {
    expect(nextUntitled(tabs)).toBe("Untitled-3.sql");
    expect(nextUntitled([])).toBe("Untitled-1.sql");
  });
});

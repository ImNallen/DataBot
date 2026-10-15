import { describe, expect, it } from "vitest";
import type { ConnectionConfig, ConsoleState, OutputEntry, QueryError, ResultMeta, RunState, StatementRun, Workspace } from "../ipc/bindings";
import { hasUncommittedWork, outputTone, resultView, rowResults, runSummary, shownResult } from "./status";
import { nextUntitled, tabFromSnapshot, workspaceSnapshot, type Tab } from "./workspace";

const meta = (index: number, rowCount: number, extra: Partial<ResultMeta> = {}): ResultMeta => ({
  ref: { tabId: "t", runId: 1, index },
  db: { connectionId: "c", database: "shop" },
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
  return { tabId: "t", rev: 1, config: { connectionId: "c", database: "shop", schema: null, mode }, session: { kind: "None" }, txn, run: { kind: "Idle" } };
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

const notice = (runId: number, message: string, severity = "NOTICE"): OutputEntry => ({
  atMs: 0,
  runId,
  body: { kind: "Notice", severity, message, detail: null },
});
const failure: QueryError = { severity: "ERROR", sqlstate: "40001", message: "could not serialize", detail: null, hint: null, context: null, position: null };
const finishedRun = (runId: number, statements: StatementRun[] = []): RunState => ({ kind: "Finished", runId, elapsedMs: 5, statements, outcome: "Ok" });
const rowsAt = (index: number) => stmt(index, { kind: "Rows", result: meta(index, 1), done: true });

describe("resultView", () => {
  const withRows = finishedRun(7, [rowsAt(0), rowsAt(1)]);

  it("shows an Output pick made on the current run over the grid", () => {
    expect(resultView(withRows, { kind: "output", runId: 7, result: undefined }, true)).toEqual({ kind: "output" });
  });

  it("keeps the picked result set behind an Output pick", () => {
    expect(shownResult(withRows, { kind: "output", runId: 7, result: 0 })).toMatchObject({ index: 0 });
    expect(resultView(withRows, { kind: "output", runId: 7, result: 0 }, false)).toMatchObject({ kind: "rows", result: { index: 0 } });
  });

  it("forgets the result set behind a lapsed Output pick", () => {
    expect(shownResult(finishedRun(8, [rowsAt(0), rowsAt(1), rowsAt(2)]), { kind: "output", runId: 7, result: 0 })).toMatchObject({ index: 2 });
  });

  it("drops an Output pick on the next run", () => {
    expect(resultView(finishedRun(8, [rowsAt(0)]), { kind: "output", runId: 7, result: undefined }, true)).toMatchObject({ kind: "rows", result: { index: 0 } });
  });

  it("prefers the grid to the log without a pick", () => {
    expect(resultView(withRows, undefined, true)).toMatchObject({ kind: "rows", result: { index: 1 } });
    expect(resultView(withRows, 0, true)).toMatchObject({ kind: "rows", result: { index: 0 } });
  });

  it("shows the log instead of the tail when the tab has entries", () => {
    expect(resultView(finishedRun(7, [stmt(0, { kind: "Command", tag: "DO", elapsedMs: 1 })]), undefined, true)).toEqual({ kind: "output" });
  });

  it("falls back to the tail when the log is empty", () => {
    expect(resultView(finishedRun(7, [stmt(0, { kind: "Command", tag: "DO", elapsedMs: 1 })]), undefined, false)).toEqual({ kind: "tail" });
    expect(resultView(finishedRun(7), { kind: "output", runId: 7, result: undefined }, false)).toEqual({ kind: "tail" });
    expect(resultView({ kind: "Idle" }, undefined, false)).toEqual({ kind: "tail" });
  });
});

describe("outputTone", () => {
  const command = (runId: number): OutputEntry => ({ atMs: 0, runId, body: { kind: "Command", statement: 0, tag: "DO", elapsedMs: 1 } });
  const error = (runId: number): OutputEntry => ({ atMs: 0, runId, body: { kind: "Error", statement: 0, error: failure } });

  it("turns amber for a WARNING in the latest run", () => {
    expect(outputTone([notice(7, "careful", "WARNING"), command(7)])).toBe("warn");
  });

  it("stays muted once a later run raised no WARNING", () => {
    expect(outputTone([notice(7, "careful", "WARNING"), command(7), command(8)])).toBe("muted");
  });

  it("stays muted for other notices and for errors", () => {
    expect(outputTone([notice(7, "fyi"), notice(7, "info", "INFO"), error(7)])).toBe("muted");
    expect(outputTone([])).toBe("muted");
  });
});

describe("workspace snapshot", () => {
  const configs: Record<string, ConnectionConfig> = {
    c: { id: "c", name: "dev", host: "localhost", port: 5433, database: "shop", user: "l1data", sslMode: "Prefer", caCertPath: null, hasPassword: true, color: null },
  };
  const tabs: Tab[] = [
    { kind: "sql", id: "a", title: "Untitled-2.sql", console: { db: { connectionId: "c", database: "reporting" }, mode: "Manual" } },
    {
      kind: "table",
      id: "b",
      db: { connectionId: "c", database: "shop" },
      schema: "public",
      table: "orders",
      page: 3,
      query: { orderBy: "total DESC", filters: [{ column: "status", op: "Eq", value: "paid" }], where: "total > 10" },
    },
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
    expect(snap.tabs[1]).toMatchObject({ kind: "Sql", text: "-- text of a", console: { connectionId: "c", database: "reporting", schema: null, mode: "Manual" } });
    expect(snap.tabs[0]).toMatchObject({ kind: "Table", connectionId: "c", database: "shop", table: "orders" });
    expect(snap.tabs.map((t) => tabFromSnapshot(t, configs))).toEqual([tabs[1], tabs[0]]);
    expect(snap.layout).toEqual(state.layout);
  });

  it("restores a table tab saved before tabs had a query with no sort or filter", () => {
    expect(tabFromSnapshot({ kind: "Table", id: "b", connectionId: "c", database: "shop", schema: "public", table: "orders", page: 0 }, configs)).toMatchObject({
      query: { orderBy: "", filters: [], where: "" },
    });
  });

  it("restores a workspace saved before tabs carried a database onto the connection's configured database", () => {
    // Exactly what workspace_save wrote before this version: no `database` on either tab kind, and a per-tab schema.
    const saved = JSON.parse(
      '{"tabs":[{"kind":"Sql","id":"a","title":"q.sql","text":"select 1","console":{"connectionId":"c","schema":"lab","mode":"AutoCommit"}},' +
        '{"kind":"Table","id":"b","connectionId":"c","schema":"public","table":"orders","page":2,"query":{"orderBy":"","filters":[],"where":""}},' +
        '{"kind":"Sql","id":"d","title":"free.sql","text":"","console":{"connectionId":null,"schema":null,"mode":"Manual"}}],' +
        '"active":"b","layout":{"sidebar":true,"results":true,"rightPanel":null,"resultsHeight":320,"sidebarWidth":256,"rightPanelWidth":341}}',
    ) as Workspace;
    expect(saved.tabs.map((t) => tabFromSnapshot(t, configs))).toEqual([
      { kind: "sql", id: "a", title: "q.sql", console: { db: { connectionId: "c", database: "shop" }, mode: "AutoCommit" } },
      { kind: "table", id: "b", db: { connectionId: "c", database: "shop" }, schema: "public", table: "orders", page: 2, query: { orderBy: "", filters: [], where: "" } },
      { kind: "sql", id: "d", title: "free.sql", console: { db: null, mode: "Manual" } },
    ]);
  });

  it("drops a table tab whose connection is gone and unbinds a SQL tab", () => {
    const table = { kind: "Table" as const, id: "b", connectionId: "gone", database: "shop", schema: "public", table: "orders", page: 0, query: { orderBy: "", filters: [], where: "" } };
    const sql = { kind: "Sql" as const, id: "a", title: "q.sql", text: "", console: { connectionId: "gone", database: "shop", schema: null, mode: "AutoCommit" as const } };
    expect(tabFromSnapshot(table, configs)).toBeNull();
    expect(tabFromSnapshot(sql, configs)).toEqual({ kind: "sql", id: "a", title: "q.sql", console: { db: null, mode: "AutoCommit" } });
  });

  it("numbers new tabs after the highest Untitled", () => {
    expect(nextUntitled(tabs)).toBe("Untitled-3.sql");
    expect(nextUntitled([])).toBe("Untitled-1.sql");
  });
});

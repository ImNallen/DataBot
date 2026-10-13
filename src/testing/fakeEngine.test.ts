import { describe, expect, it } from "vitest";
import type { AppEvent, RowPage, RunAccepted } from "../ipc/bindings";
import { applyEvent, emptyLive, type LiveData } from "../state/live";
import { runSummary } from "../state/status";
import { FakeEngine } from "./fakeEngine";
import { MOCKUP_SQL } from "./fakeData";
import { pickStatements, splitSql } from "./fakeSql";

function harness() {
  let live: LiveData = emptyLive;
  const events: AppEvent[] = [];
  const engine = new FakeEngine(
    (e) => {
      events.push(e);
      live = applyEvent(live, e);
    },
    { latency: 0 },
  );
  const call = <T,>(cmd: string, args: Record<string, unknown> = {}) => engine.invoke(cmd, args) as Promise<T>;
  const settle = () => new Promise((r) => setTimeout(r, 5));
  async function finished(tabId: string) {
    for (let i = 0; i < 200 && live.consoles[tabId]?.run.kind !== "Finished"; i++) await settle();
    return live.consoles[tabId]!;
  }
  return { engine, events, call, finished, live: () => live };
}

async function connected() {
  const h = harness();
  const boot = await h.call<{ connections: { id: string; name: string }[] }>("app_boot");
  const prod = boot.connections.find((c) => c.name === "prod-postgres")!;
  await h.call("connection_connect", { id: prod.id });
  await h.call("console_configure", { tabId: "tab", config: { connectionId: prod.id, schema: "public", mode: "AutoCommit" } });
  return { ...h, conn: prod.id };
}

describe("fake splitter", () => {
  it("ignores semicolons inside strings, comments, and dollar quotes", () => {
    const sql = "select ';' as a; -- x;y\nselect $$a;b$$; /* ; */ select 3";
    expect(splitSql(sql).map((r) => sql.slice(r.from, r.to))).toEqual(["select ';' as a;", "-- x;y\nselect $$a;b$$;", "/* ; */ select 3"]);
  });

  it("picks the statement under the cursor or the one just before it", () => {
    const sql = "select 1;\n\nselect 2;\n";
    expect(pickStatements(sql, { kind: "cursor", offset: 3 })).toEqual([{ from: 0, to: 9 }]);
    expect(pickStatements(sql, { kind: "cursor", offset: sql.length })).toEqual([{ from: 11, to: 20 }]);
  });
});

describe("FakeEngine through the live projection", () => {
  it("connects with Connecting then Connected and serves the shop catalog", async () => {
    const h = await connected();
    const kinds = h.events.filter((e) => e.kind === "ConnectionChanged").map((e) => (e.kind === "ConnectionChanged" ? e.status.kind : ""));
    expect(kinds).toEqual(["Connecting", "Connected"]);
    const catalog = await h.call<{ database: string; schemas: { name: string }[] }>("catalog_get", { id: h.conn });
    expect(catalog.database).toBe("shop");
    expect(catalog.schemas.map((s) => s.name)).toEqual(["lab", "public"]);
  });

  it("runs the mockup query to six rows with orders as bigint", async () => {
    const h = await connected();
    const accepted = await h.call<RunAccepted>("console_run", { tabId: "tab", request: { kind: "script", text: MOCKUP_SQL, target: { kind: "cursor", offset: 10 } } });
    expect(accepted.statements).toHaveLength(1);
    const state = await h.finished("tab");
    expect(runSummary(state.run, undefined, 0)?.text).toMatch(/^6 rows · \d+ ms$/);
    if (state.run.kind !== "Finished" || state.run.statements[0]?.status.kind !== "Rows") throw new Error("expected rows");
    const meta = state.run.statements[0].status.result;
    expect(meta.columns.map((c) => `${c.name}:${c.type.display}`)).toContain("orders:bigint");
    const page = await h.call<RowPage>("result_page", { resultRef: meta.ref, start: 0, len: 256 });
    expect(page.rows[0]).toEqual(["US-East", "3402", "1021447.90", "300.25", "2026-10-13 10:14:07.412+02"]);
  });

  it("truncates a large series at maxRows and cuts long cells", async () => {
    const h = await connected();
    await h.call("console_run", { tabId: "tab", request: { kind: "script", text: "select * from generate_series(1, 300000) g", target: { kind: "all" } } });
    const state = await h.finished("tab");
    if (state.run.kind !== "Finished" || state.run.statements[0]?.status.kind !== "Rows") throw new Error("expected rows");
    const meta = state.run.statements[0].status.result;
    expect([meta.rowCount, meta.rowsSeen, meta.truncated]).toEqual([200_000, 300_000, "RowLimit"]);
    const page = await h.call<RowPage>("result_page", { resultRef: meta.ref, start: 0, len: 256 });
    expect(page.cut).toContainEqual([7, 5]);
    expect(page.rows[7]![5]).toHaveLength(2_000);
    const full = await h.call<string>("result_cell", { resultRef: meta.ref, row: 7, col: 5 });
    expect(full.length).toBeGreaterThan(2_000);
  });

  it("cancels a slow run and reports the PG cancel message", async () => {
    const h = await connected();
    await h.call("console_run", { tabId: "tab", request: { kind: "script", text: "select slow_echo(30)", target: { kind: "all" } } });
    await new Promise((r) => setTimeout(r, 5));
    expect(h.live().consoles.tab?.run.kind).toBe("Running");
    await h.call("console_cancel", { tabId: "tab" });
    const state = await h.finished("tab");
    expect(state.run.kind === "Finished" && state.run.outcome).toBe("Cancelled");
    const messages = (h.live().output.tab ?? []).map((e) => (e.body.kind === "Error" ? e.body.error.message : ""));
    expect(messages).toContain("canceling statement due to user request");
  });

  it("opens an implicit transaction in manual mode until commit", async () => {
    const h = await connected();
    await h.call("console_configure", { tabId: "tab", config: { connectionId: h.conn, schema: "public", mode: "Manual" } });
    await h.call("console_run", { tabId: "tab", request: { kind: "script", text: "insert into customers(name) values ('t')", target: { kind: "all" } } });
    expect((await h.finished("tab")).txn).toBe("Active");
    await expect(h.call("console_configure", { tabId: "tab", config: { connectionId: h.conn, schema: "public", mode: "AutoCommit" } })).rejects.toEqual({ kind: "TransactionOpen" });
    await h.call("console_commit", { tabId: "tab" });
    expect(h.live().consoles.tab?.txn).toBe("Idle");
  });

  it("maps an unknown relation to an error positioned in the document", async () => {
    const h = await connected();
    const text = "select 1;\nselect * from nope";
    await h.call("console_run", { tabId: "tab", request: { kind: "script", text, target: { kind: "cursor", offset: text.length } } });
    const state = await h.finished("tab");
    const status = state.run.kind === "Finished" ? state.run.statements[0]?.status : undefined;
    expect(status?.kind === "Failed" && status.error.position).toBe(text.indexOf("nope"));
  });

  it("rejects typed errors as raw values, the way the generated typedError expects", async () => {
    const h = harness();
    await expect(h.call("console_run", { tabId: "nobody", request: { kind: "script", text: "select 1", target: { kind: "all" } } })).rejects.toEqual({ kind: "NotConfigured" });
    await expect(h.call("no_such_command")).rejects.toBeInstanceOf(Error);
  });
});

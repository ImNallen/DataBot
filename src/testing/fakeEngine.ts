import type {
  AppEvent,
  BootSnapshot,
  ColumnMeta,
  commands,
  ConnectError,
  ConnectionConfig,
  ConnectionDraft,
  ConnectionId,
  ConnectionState,
  ConnStatus,
  ConsoleConfig,
  ConsoleState,
  DocRange,
  HistoryEntry,
  HistoryOutcome,
  HistoryQuery,
  OutputBody,
  QueryError,
  ResultMeta,
  ResultRef,
  RowPage,
  RunRequest,
  RunState,
  ServerInfo,
  Settings,
  StatementRun,
  StmtStatus,
  TabId,
  TxnState,
  Workspace,
} from "../ipc/bindings";
import { columnMeta, MOCKUP_RESULT, shopCatalog, syntheticCell } from "./fakeData";
import { pickStatements, stripComments } from "./fakeSql";

type Commands = typeof commands;
type Outcome<K extends keyof Commands> = Awaited<ReturnType<Commands[K]>>;
type DataOf<R> = R extends { status: "ok"; data: infer D } ? D : R extends { status: "error" } ? never : R;
type ErrorOf<R> = R extends { status: "error"; error: infer E } ? E : never;
type Ok<K extends keyof Commands> = DataOf<Outcome<K>>;
type Err<K extends keyof Commands> = ErrorOf<Outcome<K>>;

/** Mirrors the generated `typedError`: a command error is thrown as the raw value. */
function fail<K extends keyof Commands>(_cmd: K, error: Err<K>): never {
  throw error;
}

const CELL_CHAR_LIMIT = 2_000;
const SERVER: ServerInfo = { version: "16.4", versionNum: 160_004, encoding: "UTF8" };
const STORAGE_KEY = "databot.fake.v1";

type FakeResult = { meta: ResultMeta; cell(row: number, col: number): string | null };

type FakeConsole = {
  state: ConsoleState;
  results: Map<number, FakeResult>;
  stop: { requested: boolean; wake?: () => void } | null;
};

type Persisted = { workspace: Workspace | null; history: HistoryEntry[]; connections: ConnectionConfig[] };

type Behavior = "ok" | "auth" | "network";

type Evaluation =
  | { kind: "rows"; columns: ColumnMeta[]; total: number; cell(row: number, col: number): string | null; notice?: string }
  | { kind: "command"; tag: string; txn?: "begin" | "commit" | "rollback"; ddl?: boolean }
  | { kind: "error"; error: QueryError }
  | { kind: "sleep"; seconds: number; value: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function queryError(message: string, position: number | null, extra: Partial<QueryError> = {}): QueryError {
  return { severity: "ERROR", sqlstate: "42P01", message, detail: null, hint: null, context: null, position, ...extra };
}

/**
 * An in-memory engine behind the same `mockIPC` seam as the dev-bridge. Data is shaped like the
 * seeded `shop` database; every reply and event is typed by the generated contract.
 */
export class FakeEngine {
  private rev = 0;
  private nextRunId = 1;
  private nextHistoryId = 1;
  private readonly configs = new Map<ConnectionId, ConnectionConfig>();
  private readonly passwords = new Map<ConnectionId, string>();
  private readonly behaviors = new Map<ConnectionId, Behavior>();
  private readonly live = new Map<ConnectionId, ConnectionState>();
  private readonly catalogVersions = new Map<ConnectionId, number>();
  private readonly consoles = new Map<TabId, FakeConsole>();
  private history: HistoryEntry[] = [];
  private workspace: Workspace = { tabs: [], active: null, layout: { sidebar: true, results: true, rightPanel: null, resultsHeight: 320 } };
  private settings: Settings = { maxRows: 200_000, maxResultBytes: 512 * 1024 * 1024, tablePageSize: 500, stopOnError: true };
  private readonly emit: (e: AppEvent) => void;
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | null;
  /** Scales every simulated delay; tests pass 0. */
  private readonly latency: number;

  constructor(emit: (e: AppEvent) => void, opts: { storage?: Pick<Storage, "getItem" | "setItem"> | null; latency?: number } = {}) {
    this.emit = emit;
    this.storage = opts.storage ?? null;
    this.latency = opts.latency ?? 1;
    const persisted = this.load();
    const seed: [ConnectionConfig, Behavior][] = [
      [this.config("prod-postgres", "localhost", "databot"), "ok"],
      [this.config("staging-postgres", "staging.internal", "readonly"), "auth"],
      [this.config("analytics-replica", "10.0.4.12", "analyst"), "network"],
    ];
    for (const [c, behavior] of seed) {
      this.configs.set(c.id, c);
      this.behaviors.set(c.id, behavior);
      this.passwords.set(c.id, "databot");
    }
    for (const c of persisted?.connections ?? []) {
      this.configs.set(c.id, c);
      if (!this.behaviors.has(c.id)) this.behaviors.set(c.id, "ok");
      if (c.hasPassword) this.passwords.set(c.id, "databot");
    }
    for (const id of this.configs.keys()) this.live.set(id, { id, rev: 0, status: { kind: "Disconnected" } });
    if (persisted?.workspace) this.workspace = persisted.workspace;
    this.history = persisted?.history ?? [];
    this.nextHistoryId = (this.history[0]?.id ?? 0) + 1;
  }

  /** Stable ids so a reloaded workspace still points at the seeded connections. */
  private config(name: string, host: string, user: string): ConnectionConfig {
    const hex = [...name].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, "0");
    return {
      id: `${hex}-0000-4000-8000-${hex}0000`,
      name,
      host,
      port: 5433,
      database: "shop",
      user,
      sslMode: "Prefer",
      caCertPath: null,
      hasPassword: true,
      color: null,
    };
  }

  async invoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
    // The dialog plugin rides the same invoke seam; the fake stands in for the native save panel.
    if (cmd === "plugin:dialog|save") return "/tmp/databot-fake-export.csv";
    const name = cmd.replace(/_(\w)/g, (_, c: string) => c.toUpperCase()) as keyof Commands;
    const handler = this.handlers[name] as ((a: Record<string, unknown>) => Promise<unknown>) | undefined;
    if (!handler) throw new Error(`fake engine: unknown command \`${cmd}\``);
    return handler(args);
  }

  private delay(ms: number) {
    return sleep(ms * this.latency);
  }

  private readonly handlers = {
    appBoot: async (): Promise<Ok<"appBoot">> => this.boot(),

    connectionSave: async ({ draft }: { draft: ConnectionDraft }): Promise<Ok<"connectionSave">> => {
      if (!draft.name.trim() || !draft.host.trim()) fail("connectionSave", { kind: "Invalid", message: "Name and host are required" });
      const id = draft.id ?? crypto.randomUUID();
      const pw = draft.password;
      if (pw === "Clear") this.passwords.delete(id);
      else if (pw !== "Keep") this.passwords.set(id, pw.Set);
      const config: ConnectionConfig = {
        id,
        name: draft.name.trim(),
        host: draft.host.trim(),
        port: draft.port,
        database: draft.database,
        user: draft.user,
        sslMode: draft.sslMode,
        caCertPath: draft.caCertPath,
        hasPassword: this.passwords.has(id),
        color: draft.color,
      };
      this.configs.set(id, config);
      if (!this.behaviors.has(id)) this.behaviors.set(id, "ok");
      if (!this.live.has(id)) this.setStatus(id, { kind: "Disconnected" });
      this.persist();
      return config;
    },

    connectionDelete: async ({ id }: { id: ConnectionId }): Promise<Ok<"connectionDelete">> => {
      const open = this.openTxns(id);
      if (open.length) fail("connectionDelete", { kind: "OpenTransactions", tabs: open });
      this.configs.delete(id);
      this.passwords.delete(id);
      this.setStatus(id, { kind: "Disconnected" });
      this.live.delete(id);
      this.persist();
      return null;
    },

    connectionTest: async ({ draft }: { draft: ConnectionDraft }): Promise<Ok<"connectionTest">> => {
      await this.delay(350);
      const error = this.connectProblem(draft.host, draft.id, draft.password);
      if (error) fail("connectionTest", error);
      return SERVER;
    },

    connectionConnect: async ({ id }: { id: ConnectionId }): Promise<Ok<"connectionConnect">> => {
      const config = this.configs.get(id);
      if (!config) fail("connectionConnect", { kind: "Network", message: "unknown connection" });
      if (this.live.get(id)?.status.kind === "Connected") return SERVER;
      this.setStatus(id, { kind: "Connecting" });
      await this.delay(450);
      const error = this.connectProblem(config.host, id, "Keep");
      if (error) {
        this.setStatus(id, { kind: "Failed", error });
        fail("connectionConnect", error);
      }
      const version = this.catalogVersions.get(id) ?? 1;
      this.catalogVersions.set(id, version);
      this.setStatus(id, { kind: "Connected", server: SERVER, catalogVersion: version });
      return SERVER;
    },

    connectionDisconnect: async ({ id, force }: { id: ConnectionId; force: boolean }): Promise<Ok<"connectionDisconnect">> => {
      const open = this.openTxns(id);
      if (open.length && !force) fail("connectionDisconnect", { kind: "OpenTransactions", tabs: open });
      this.setStatus(id, { kind: "Disconnected" });
      return null;
    },

    catalogGet: async ({ id }: { id: ConnectionId }): Promise<Ok<"catalogGet">> => {
      if (this.live.get(id)?.status.kind !== "Connected") fail("catalogGet", { connectionId: id });
      await this.delay(60);
      return shopCatalog(id, this.catalogVersions.get(id) ?? 1);
    },

    catalogRefresh: async ({ id }: { id: ConnectionId }): Promise<Ok<"catalogRefresh">> => {
      if (this.live.get(id)?.status.kind !== "Connected") fail("catalogRefresh", { connectionId: id });
      return this.bumpCatalog(id);
    },

    consoleConfigure: async ({ tabId, config }: { tabId: TabId; config: ConsoleConfig }): Promise<Ok<"consoleConfigure">> => {
      if (!this.configs.has(config.connectionId)) fail("consoleConfigure", { kind: "UnknownConnection" });
      const existing = this.consoles.get(tabId);
      if (existing) {
        const prev = existing.state.config;
        const structural = prev.mode !== config.mode || prev.connectionId !== config.connectionId;
        if (structural && existing.state.txn !== "Idle") fail("consoleConfigure", { kind: "TransactionOpen" });
        if (structural && existing.state.run.kind === "Running") fail("consoleConfigure", { kind: "Busy" });
        return this.updateConsole(existing, { config: { ...config } });
      }
      const console: FakeConsole = {
        state: { tabId, rev: 0, config: { ...config }, session: { kind: "None" }, txn: "Idle", run: { kind: "Idle" } },
        results: new Map(),
        stop: null,
      };
      this.consoles.set(tabId, console);
      return this.updateConsole(console, {});
    },

    consoleRun: async ({ tabId, request }: { tabId: TabId; request: RunRequest }): Promise<Ok<"consoleRun">> => {
      const console = this.consoles.get(tabId);
      if (!console) fail("consoleRun", { kind: "NotConfigured" });
      if (console.state.run.kind === "Running") fail("consoleRun", { kind: "Busy" });
      const connectError = this.connectProblem(this.configs.get(console.state.config.connectionId)?.host ?? "", console.state.config.connectionId, "Keep");
      if (connectError) fail("consoleRun", { kind: "Connect", error: connectError });
      const plan = this.plan(request);
      if (plan.length === 0) fail("consoleRun", { kind: "NoStatement" });
      const copyStdin = plan.find((p) => /^\s*copy\b[\s\S]*\bfrom\s+stdin/i.test(p.sql));
      if (copyStdin) fail("consoleRun", { kind: "Unsupported", what: "COPY FROM STDIN" });
      const runId = this.nextRunId++;
      void this.execute(console, runId, plan);
      return { runId, statements: plan.map((p) => p.range) };
    },

    consoleCancel: async ({ tabId }: { tabId: TabId }): Promise<Ok<"consoleCancel">> => {
      const stop = this.consoles.get(tabId)?.stop;
      if (stop) {
        stop.requested = true;
        stop.wake?.();
      }
    },

    consoleCommit: async ({ tabId }: { tabId: TabId }): Promise<Ok<"consoleCommit">> => this.endTxn(tabId, "COMMIT"),
    consoleRollback: async ({ tabId }: { tabId: TabId }): Promise<Ok<"consoleRollback">> => this.endTxn(tabId, "ROLLBACK"),

    consoleClose: async ({ tabId, force }: { tabId: TabId; force: boolean }): Promise<Ok<"consoleClose">> => {
      const console = this.consoles.get(tabId);
      if (console && console.state.txn !== "Idle" && !force) {
        fail("consoleClose", { kind: "OpenTransactions", tabs: [{ tabId, hasWrites: true }] });
      }
      if (console?.stop) console.stop.requested = true;
      this.consoles.delete(tabId);
      return null;
    },

    resultPage: async ({ resultRef, start, len }: { resultRef: ResultRef; start: number; len: number }): Promise<Ok<"resultPage">> => {
      const result = this.result(resultRef);
      if (!result) fail("resultPage", { kind: "Gone" });
      if (len > 2_000 || start > result.meta.rowCount) fail("resultPage", { kind: "OutOfRange" });
      await this.delay(15);
      const end = Math.min(result.meta.rowCount, start + len);
      const page: RowPage = { start, rows: [], cut: [] };
      for (let r = start; r < end; r++) {
        page.rows.push(
          result.meta.columns.map((_, c) => {
            const value = result.cell(r, c);
            if (value !== null && value.length > CELL_CHAR_LIMIT) {
              page.cut.push([r, c]);
              return value.slice(0, CELL_CHAR_LIMIT);
            }
            return value;
          }),
        );
      }
      return page;
    },

    resultCell: async ({ resultRef, row, col }: { resultRef: ResultRef; row: number; col: number }): Promise<Ok<"resultCell">> => {
      const result = this.result(resultRef);
      if (!result) fail("resultCell", { kind: "Gone" });
      if (row >= result.meta.rowCount || col >= result.meta.columns.length) fail("resultCell", { kind: "OutOfRange" });
      return result.cell(row, col);
    },

    resultExportCsv: async ({ resultRef }: { resultRef: ResultRef; path: string }): Promise<Ok<"resultExportCsv">> => {
      const result = this.result(resultRef);
      if (!result) fail("resultExportCsv", { kind: "Gone" });
      await this.delay(200);
      return { rows: result.meta.rowCount, bytes: result.meta.rowCount * 64, truncated: result.meta.truncated !== null };
    },

    historyList: async ({ query }: { query: HistoryQuery }): Promise<Ok<"historyList">> => {
      const needle = query.text?.toLowerCase() ?? "";
      const matches = this.history.filter(
        (h) =>
          (query.beforeId === null || h.id < query.beforeId) &&
          (query.connectionId === null || h.connectionId === query.connectionId) &&
          (!needle || h.sql.toLowerCase().includes(needle)),
      );
      return { entries: matches.slice(0, query.limit), hasMore: matches.length > query.limit };
    },

    historyClear: async (): Promise<Ok<"historyClear">> => {
      this.history = [];
      this.persist();
    },

    workspaceSave: async ({ workspace }: { workspace: Workspace }): Promise<Ok<"workspaceSave">> => {
      this.workspace = workspace;
      this.persist();
    },

    settingsSet: async ({ settings }: { settings: Settings }): Promise<Ok<"settingsSet">> => {
      this.settings = settings;
    },
  } satisfies { [K in keyof Commands]: (args: never) => Promise<Ok<K>> };

  boot(): BootSnapshot {
    return {
      connections: [...this.configs.values()],
      live: [...this.live.values()],
      consoles: [...this.consoles.values()].map((c) => c.state),
      workspace: this.workspace,
      settings: this.settings,
    };
  }

  // ---- connections ---------------------------------------------------------------

  private connectProblem(host: string, id: ConnectionId | null, password: ConnectionDraft["password"]): ConnectError | null {
    const behavior = id ? this.behaviors.get(id) : undefined;
    if (behavior === "network" || (!id && !/^(localhost|127\.0\.0\.1)$/.test(host))) {
      return { kind: "Network", message: `could not connect to server: Connection refused (${host}:5433)` };
    }
    const secret = typeof password === "object" ? password.Set : password === "Keep" && id ? this.passwords.get(id) : undefined;
    if (behavior === "auth" || secret === "wrong") {
      return { kind: "Auth", message: 'password authentication failed for user "readonly"' };
    }
    if (secret === undefined) return { kind: "MissingPassword" };
    return null;
  }

  private setStatus(id: ConnectionId, status: ConnStatus) {
    const state: ConnectionState = { id, rev: ++this.rev, status };
    this.live.set(id, state);
    this.emit({ kind: "ConnectionChanged", ...state });
  }

  private bumpCatalog(id: ConnectionId): number {
    const version = (this.catalogVersions.get(id) ?? 1) + 1;
    this.catalogVersions.set(id, version);
    this.emit({ kind: "CatalogChanged", connectionId: id, version });
    this.setStatus(id, { kind: "Connected", server: SERVER, catalogVersion: version });
    return version;
  }

  private openTxns(id: ConnectionId) {
    return [...this.consoles.values()]
      .filter((c) => c.state.config.connectionId === id && c.state.txn !== "Idle")
      .map((c) => ({ tabId: c.state.tabId, hasWrites: true }));
  }

  // ---- consoles --------------------------------------------------------------------

  private updateConsole(console: FakeConsole, patch: Partial<Omit<ConsoleState, "tabId" | "rev">>): ConsoleState {
    console.state = { ...console.state, ...patch, rev: ++this.rev };
    this.emit({ kind: "ConsoleChanged", ...console.state });
    return console.state;
  }

  private output(tabId: TabId, runId: number | null, ...bodies: OutputBody[]) {
    this.emit({ kind: "ConsoleOutput", tabId, entries: bodies.map((body) => ({ atMs: Date.now(), runId, body })) });
  }

  private async endTxn(tabId: TabId, verb: "COMMIT" | "ROLLBACK"): Promise<null> {
    const cmd = verb === "COMMIT" ? "consoleCommit" : "consoleRollback";
    const console = this.consoles.get(tabId);
    if (!console || console.state.txn === "Idle") fail(cmd, { kind: "NoTransaction" });
    if (console.state.run.kind === "Running") fail(cmd, { kind: "Busy" });
    const aborted = console.state.txn === "Aborted";
    await this.delay(40);
    this.updateConsole(console, { txn: "Idle" });
    this.output(tabId, null, { kind: "Info", message: aborted && verb === "COMMIT" ? "ROLLBACK (transaction was aborted)" : verb });
    if (aborted && verb === "COMMIT") fail(cmd, { kind: "RolledBack" });
    return null;
  }

  private result(ref: ResultRef): FakeResult | undefined {
    const console = this.consoles.get(ref.tabId);
    const run = console?.state.run;
    if (!console || run?.kind === "Idle" || run?.runId !== ref.runId) return undefined;
    return console.results.get(ref.index);
  }

  private plan(request: RunRequest): { range: DocRange; sql: string; table?: { schema: string; table: string; page: number } }[] {
    if (request.kind === "tablePage") {
      const sql = `SELECT * FROM "${request.schema}"."${request.table}" ORDER BY 1 LIMIT ${this.settings.tablePageSize} OFFSET ${request.page * this.settings.tablePageSize}`;
      return [{ range: { from: 0, to: 0 }, sql, table: request }];
    }
    return pickStatements(request.text, request.target).map((range) => ({ range, sql: request.text.slice(range.from, range.to) }));
  }

  private async execute(console: FakeConsole, runId: number, plan: ReturnType<FakeEngine["plan"]>) {
    const tabId = console.state.tabId;
    const startedAtMs = Date.now();
    const stop: NonNullable<FakeConsole["stop"]> = { requested: false };
    console.stop = stop;
    console.results = new Map();
    const statements: StatementRun[] = plan.map((p, index) => ({ index, range: p.range, status: { kind: "Pending" } }));
    const running = (): RunState => ({ kind: "Running", runId, startedAtMs, statements: statements.map((s) => ({ ...s })) });
    const set = (i: number, status: StmtStatus) => {
      statements[i] = { ...statements[i]!, status };
      this.updateConsole(console, { run: running() });
    };
    this.updateConsole(console, { run: running(), session: { kind: "Open", backendPid: 41_000 + (runId % 1000) } });

    let outcome: "Ok" | "Failed" | "Cancelled" = "Ok";
    for (const [i, step] of plan.entries()) {
      if (stop.requested) {
        outcome = "Cancelled";
        for (let j = i; j < plan.length; j++) set(j, { kind: "Skipped" });
        break;
      }
      set(i, { kind: "Preparing" });
      await this.delay(25);
      const evaluation = step.table ? this.tablePage(step.table) : this.evaluate(step.sql, step.range.from);

      const explicitTxn = evaluation.kind === "command" && evaluation.txn !== undefined;
      if (evaluation.kind !== "error" && !explicitTxn && this.needsImplicitBegin(console, step.sql)) {
        this.beginImplicit(console, runId);
      }
      const t0 = Date.now();
      let ok = true;
      switch (evaluation.kind) {
        case "rows": {
          const total = evaluation.total;
          const rowCount = Math.min(total, this.settings.maxRows);
          const ref: ResultRef = { tabId, runId, index: i };
          const meta = (count: number, done: boolean): ResultMeta => ({
            ref,
            columns: evaluation.columns,
            rowCount: count,
            rowsSeen: done ? total : count,
            truncated: done && total > rowCount ? "RowLimit" : null,
            elapsedMs: Math.max(1, Date.now() - t0),
          });
          const result: FakeResult = { meta: meta(0, false), cell: evaluation.cell };
          console.results.set(i, result);
          const steps = rowCount > 5_000 ? 6 : 1;
          for (let k = 1; k < steps && !stop.requested; k++) {
            await this.delay(140);
            result.meta = meta(Math.floor((rowCount * k) / steps), false);
            set(i, { kind: "Rows", result: result.meta, done: false });
          }
          if (stop.requested) {
            ok = false;
            outcome = "Cancelled";
            set(i, { kind: "Cancelled" });
            this.output(tabId, runId, { kind: "Error", statement: i, error: queryError("canceling statement due to user request", null, { sqlstate: "57014" }) });
            break;
          }
          await this.delay(steps === 1 ? 12 : 140);
          result.meta = meta(rowCount, true);
          if (evaluation.notice) this.output(tabId, runId, { kind: "Notice", severity: "NOTICE", message: evaluation.notice, detail: null });
          set(i, { kind: "Rows", result: result.meta, done: true });
          this.output(tabId, runId, { kind: "Rows", statement: i, rows: rowCount, elapsedMs: result.meta.elapsedMs, truncated: result.meta.truncated !== null });
          this.record(console, step.sql, result.meta.elapsedMs, { kind: "Rows", rows: rowCount });
          break;
        }
        case "sleep": {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, evaluation.seconds * 1000);
            stop.wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          stop.wake = undefined;
          const elapsedMs = Date.now() - t0;
          if (stop.requested) {
            ok = false;
            outcome = "Cancelled";
            set(i, { kind: "Cancelled" });
            this.output(tabId, runId, { kind: "Error", statement: i, error: queryError("canceling statement due to user request", null, { sqlstate: "57014", context: "SQL statement \"SELECT pg_sleep(secs)\"\nPL/pgSQL function slow_echo(double precision) line 1 at PERFORM" }) });
            this.record(console, step.sql, elapsedMs, { kind: "Cancelled" });
            if (console.state.txn === "Active") this.updateConsole(console, { txn: "Aborted" });
            break;
          }
          const ref: ResultRef = { tabId, runId, index: i };
          const meta: ResultMeta = { ref, columns: [columnMeta("slow_echo", "double precision")], rowCount: 1, rowsSeen: 1, truncated: null, elapsedMs };
          console.results.set(i, { meta, cell: () => evaluation.value });
          this.output(tabId, runId, { kind: "Notice", severity: "NOTICE", message: `slept ${evaluation.value} seconds`, detail: null });
          set(i, { kind: "Rows", result: meta, done: true });
          this.output(tabId, runId, { kind: "Rows", statement: i, rows: 1, elapsedMs, truncated: false });
          this.record(console, step.sql, elapsedMs, { kind: "Rows", rows: 1 });
          break;
        }
        case "command": {
          await this.delay(20);
          const elapsedMs = Math.max(1, Date.now() - t0);
          const txn: TxnState = evaluation.txn === "begin" ? "Active" : evaluation.txn ? "Idle" : console.state.txn;
          if (txn !== console.state.txn) this.updateConsole(console, { txn });
          set(i, { kind: "Command", tag: evaluation.tag, elapsedMs });
          this.output(tabId, runId, { kind: "Command", statement: i, tag: evaluation.tag, elapsedMs });
          this.record(console, step.sql, elapsedMs, { kind: "Command", tag: evaluation.tag });
          if (evaluation.ddl && console.state.txn === "Idle") this.bumpCatalog(console.state.config.connectionId);
          break;
        }
        case "error": {
          ok = false;
          outcome = "Failed";
          if (console.state.txn === "Active") this.updateConsole(console, { txn: "Aborted" });
          set(i, { kind: "Failed", error: evaluation.error });
          this.output(tabId, runId, { kind: "Error", statement: i, error: evaluation.error });
          this.record(console, step.sql, Date.now() - t0, { kind: "Error", message: evaluation.error.message });
          break;
        }
        default: {
          const unreachable: never = evaluation;
          return unreachable;
        }
      }
      if (!ok && (outcome === "Cancelled" || this.settings.stopOnError)) {
        for (let j = i + 1; j < plan.length; j++) set(j, { kind: "Skipped" });
        break;
      }
    }
    console.stop = null;
    this.updateConsole(console, {
      run: { kind: "Finished", runId, elapsedMs: Date.now() - startedAtMs, statements, outcome },
    });
  }

  private needsImplicitBegin(console: FakeConsole, sql: string): boolean {
    const verb = /^\s*(\w+)/.exec(stripComments(sql))?.[1]?.toLowerCase() ?? "";
    const writes = ["insert", "update", "delete", "create", "alter", "drop", "truncate", "select"].includes(verb);
    return console.state.config.mode === "Manual" && console.state.txn === "Idle" && writes;
  }

  private beginImplicit(console: FakeConsole, runId: number) {
    this.updateConsole(console, { txn: "Active" });
    this.output(console.state.tabId, runId, { kind: "Info", message: "BEGIN (implicit)" });
  }

  private record(console: FakeConsole, sql: string, elapsedMs: number, outcome: HistoryOutcome) {
    const config = this.configs.get(console.state.config.connectionId);
    const entry: HistoryEntry = {
      id: this.nextHistoryId++,
      atMs: Date.now(),
      connectionId: console.state.config.connectionId,
      connectionName: config?.name ?? "?",
      database: config?.database ?? "?",
      sql: sql.trim(),
      elapsedMs,
      outcome,
    };
    this.history.unshift(entry);
    this.history = this.history.slice(0, 10_000);
    this.persist();
    this.emit({ kind: "HistoryAppended", ...entry });
  }

  // ---- evaluation --------------------------------------------------------------------

  private relation(schema: string, table: string) {
    return shopCatalog("", 1)
      .schemas.find((s) => s.name === schema)
      ?.relations.find((r) => r.name === table);
  }

  private tablePage(target: { schema: string; table: string; page: number }): Evaluation {
    const rel = this.relation(target.schema, target.table);
    if (!rel) return { kind: "error", error: queryError(`relation "${target.schema}.${target.table}" does not exist`, null) };
    const size = this.settings.tablePageSize;
    const offset = target.page * size;
    const estimate = rel.rowEstimate ?? 120;
    return {
      kind: "rows",
      columns: rel.columns.map((c) => columnMeta(c.name, c.typeDisplay)),
      total: Math.max(0, Math.min(size, estimate - offset)),
      cell: (r, c) => {
        const col = rel.columns[c]!;
        return syntheticCell(col.name, col.typeDisplay, col.notNull, offset + r, c);
      },
    };
  }

  private evaluate(raw: string, docFrom: number): Evaluation {
    const sql = stripComments(raw).replace(/;\s*$/, "").trim();
    const lower = sql.toLowerCase().replace(/\s+/g, " ");
    const verb = /^(\w+)/.exec(lower)?.[1] ?? "";
    const at = (needle: string) => {
      const idx = raw.indexOf(needle);
      return idx === -1 ? docFrom : docFrom + idx;
    };

    if (verb === "begin" || verb === "start") return { kind: "command", tag: "BEGIN", txn: "begin" };
    if (verb === "commit" || verb === "end") return { kind: "command", tag: "COMMIT", txn: "commit" };
    if (verb === "rollback" || verb === "abort") return { kind: "command", tag: "ROLLBACK", txn: "rollback" };

    const slow = /(?:slow_echo|pg_sleep)\(\s*([\d.]+)\s*\)/.exec(lower);
    if (slow) return { kind: "sleep", seconds: Number(slow[1]), value: slow[1]! };

    const series = /generate_series\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(lower);
    if (series) {
      const total = Math.max(0, Number(series[2]) - Number(series[1]) + 1);
      const columns = [
        columnMeta("id", "bigint"),
        columnMeta("customer", "text"),
        columnMeta("region", "text"),
        columnMeta("total", "numeric"),
        columnMeta("created_at", "timestamptz"),
        columnMeta("note", "text"),
      ];
      return {
        kind: "rows",
        columns,
        total,
        cell: (r, c) => (c === 1 ? `Customer ${(r * 7919) % 18_400}` : syntheticCell(columns[c]!.name, columns[c]!.type.display, c !== 5, r, c)),
      };
    }

    if (lower.includes("group by c.region") || lower.includes("revenue_by_region")) {
      return { kind: "rows", columns: MOCKUP_RESULT.columns, total: MOCKUP_RESULT.rows.length, cell: (r, c) => MOCKUP_RESULT.rows[r]![c]! };
    }

    if (verb === "do") return { kind: "command", tag: "DO" };
    if (verb === "set") return { kind: "command", tag: "SET" };
    if (["insert", "update", "delete"].includes(verb)) {
      const n = verb === "insert" ? (sql.match(/\)\s*,\s*\(/g)?.length ?? 0) + 1 : 3;
      return { kind: "command", tag: verb === "insert" ? `INSERT 0 ${n}` : `${verb.toUpperCase()} ${n}` };
    }
    const ddl = /^(create|alter|drop|truncate) (\w+)/.exec(lower);
    if (ddl) return { kind: "command", tag: `${ddl[1]!.toUpperCase()} ${ddl[2]!.toUpperCase()}`, ddl: true };

    if (verb === "select" || verb === "table") {
      const from = /\bfrom ([\w."]+)/.exec(lower);
      if (!from) {
        const items = sql.replace(/^select\s+/i, "").split(",").map((s) => s.trim());
        return {
          kind: "rows",
          columns: items.map((it) => {
            const alias = /\s+as\s+(\w+)$/i.exec(it)?.[1];
            const numeric = /^-?\d+(\.\d+)?$/.test(it);
            return columnMeta(alias ?? "?column?", numeric ? (it.includes(".") ? "numeric" : "integer") : "text");
          }),
          total: 1,
          cell: (_, c) => items[c]!.replace(/\s+as\s+\w+$/i, "").replace(/^'(.*)'$/, "$1"),
        };
      }
      const name = from[1]!.replace(/"/g, "");
      const [schema, table] = name.includes(".") ? name.split(".") : ["public", name];
      const rel = this.relation(schema!, table!);
      if (!rel) return { kind: "error", error: queryError(`relation "${name}" does not exist`, at(/from\s+([\w."]+)/i.exec(raw)?.[1] ?? name)) };
      const limit = /\blimit (\d+)/.exec(lower);
      const total = Math.min(rel.rowEstimate ?? 120, limit ? Number(limit[1]) : Infinity);
      return {
        kind: "rows",
        columns: rel.columns.map((c) => columnMeta(c.name, c.typeDisplay)),
        total,
        cell: (r, c) => {
          const col = rel.columns[c]!;
          return syntheticCell(col.name, col.typeDisplay, col.notNull, r, c);
        },
      };
    }

    const word = /^\s*(\S+)/.exec(sql)?.[1] ?? sql;
    return {
      kind: "error",
      error: queryError(`syntax error at or near "${word}"`, at(word), { sqlstate: "42601" }),
    };
  }

  // ---- persistence (fake only: lets a page reload behave like an app restart) -----------

  private load(): Persisted | null {
    const raw = this.storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Persisted;
    } catch {
      return null;
    }
  }

  private persist() {
    const seeded = new Set(["prod-postgres", "staging-postgres", "analytics-replica"]);
    const data: Persisted = {
      workspace: this.workspace,
      history: this.history.slice(0, 500),
      connections: [...this.configs.values()].filter((c) => !seeded.has(c.name)),
    };
    this.storage?.setItem(STORAGE_KEY, JSON.stringify(data));
  }
}

/** Installs the fake behind `mockIPC`, the same seam the dev-bridge shim uses. */
export async function installFakeEngine(): Promise<FakeEngine> {
  const [{ mockIPC }, { emit }] = await Promise.all([import("@tauri-apps/api/mocks"), import("@tauri-apps/api/event")]);
  const engine = new FakeEngine((e) => void emit("app-event", e), { storage: window.localStorage });
  mockIPC((cmd, args) => engine.invoke(cmd, (args ?? {}) as Record<string, unknown>), { shouldMockEvents: true });
  return engine;
}

# L1 Data v1 architecture

## Problem

L1 Data is a greenfield Tauri 2 desktop IDE for PostgreSQL, built to match the mockup: a connection tree, SQL editor tabs, a results grid, an output log, and per-tab transactions. The shape isn't obvious for five reasons:

- **Arbitrary PG values must cross IPC.** These include numeric, timestamptz, arrays, enums, composites, bytea, and extension types. Showing them correctly normally means one decoder per type. The long tail (ranges, tsvector, PostGIS, user composites) never ends.
- **Large results** (tens of thousands of rows, sometimes millions by accident) must stay fast without exhausting the webview's memory.
- **Sessions are stateful.** A manual-transaction tab owns an open transaction. `SET search_path` and temp tables must stick for the tab. Cancel and a dead socket must leave every tab in a state the user can reason about.
- **Two languages share one contract**, and nothing may drift between them.
- **An agent must prove the app works end to end** on macOS without a human clicking.

Verified constraints the design honors:

- `tokio-postgres` 0.7.18 has `CancelToken` and a streaming `simple_query_raw`. Its `SimpleColumn` exposes only `name()`, so no type OIDs come back from the simple protocol. `Statement::columns()` from `prepare` gives `Type` (custom enum and composite names resolved) plus `table_oid()` and `column_id()`. `SimpleQueryMessage::CommandComplete(u64)` carries a row count, not the textual tag.
- `sqlx` has no server-side cancel request.
- `tauri-specta` 2.0.0-rc.25 generates typed commands and events and supports `tauri::ipc::Channel` arguments.
- `keyring` 4.2 (default feature `v1`) provides `Entry::new(service, user)`, `set_secret`, and `get_secret`, backed by Keychain on macOS, Credential Manager on Windows, and Secret Service on Linux.
- `chacha20poly1305` 0.10 provides `XChaCha20Poly1305`, which seals saved passwords.
- `@codemirror/lang-sql` ships a `PostgreSQL` dialect and schema-aware completion (`schema`, `defaultSchema`).
- `tauri-driver` does not support macOS. `@wdio/tauri-service` with the embedded provider (`tauri-plugin-wdio-webdriver` 1.5.0) does.

## Usage (caller's view)

### README quickstart (developer)

```sh
pnpm install
pnpm db:up              # docker compose -f dev/docker-compose.yml: postgres:16 on :5433, seeded `shop` db + lab.type_zoo
pnpm tauri dev          # app; bindings regenerate on every debug build
pnpm bridge             # dev-bridge on :7077 + vite on :5173: the real Engine driven from a plain browser
cargo test -p engine                       # pure unit tests, no DB
cargo test -p engine --features pg-tests   # engine against the Docker DB
pnpm test                                  # vitest: reducers, formatting
pnpm typecheck                             # tsc --noEmit
pnpm bindings                              # rewrite src/ipc/bindings.ts without opening a window
pnpm self-check                            # debug binary boots Engine inside Tauri, connects, prints JSON, exits
cargo build -p dev-bridge && dev/bridge-smoke.sh   # curl flow against the bridge, checks the SSE stream
pnpm screenshot                            # macOS: rewrite docs/images/l1-data.png from the real app
pnpm icons                                 # rewrite src-tauri/icons from src-tauri/app-icon.svg
```

### Call site 1: frontend boot (src/boot.ts)

```ts
export async function boot(): Promise<void> {
  installRunBehavior();                            // ⌘↵, Escape, doc and cursor listeners for every editor
  // Listen first, then snapshot. Every event carries a full entity snapshot with a `rev`,
  // so an event that races the boot snapshot is harmless: the reducer keeps the higher rev.
  await listen<AppEvent>("app-event", (e) => useLive.getState().apply(e.payload));
  const snapshot = await commands.appBoot();       // live connections + consoles + workspace + settings
  useLive.getState().hydrate(snapshot);
  for (const tab of snapshot.workspace.tabs) seedEditor(tab.id, tab.kind === "Sql" ? tab.text : browseQuery(tab.schema, tab.table));
  useWorkspace.getState().restore(snapshot.workspace, snapshot.connections, snapshot.settings);
  startTheme();
  if (snapshot.workspace.tabs.length === 0) openSqlTab();
  startPersistence();                              // debounced workspace_save
  startCatalogSync();                              // useCatalog holds exactly the Ready catalogs in the connection snapshots
}
```

### Call site 2: run the active tab (features/editor/runActions.ts)

`runActive()` runs the active tab through the private `runTab`. A table tab sends `tablePage` only while its editor still holds `browseQuery(schema, table)`. Any other text runs as a script.

```ts
async function runTab(tabId: TabId, target?: PageTarget): Promise<void> {
  // ...queue page requests that arrive mid-run, then ensureConsole(tab)
  let request: RunRequest;
  if (tab.kind === "table" && isBrowsing(tab)) {
    request = { kind: "tablePage", schema: tab.schema, table: tab.table, page: target?.page ?? tab.page, query: tab.query };
  } else {
    const state = editorStateOf(tabId);
    const sel = state.selection.main;
    request = {
      kind: "script",
      text: state.doc.toString(),
      target: sel.empty ? { kind: "cursor", offset: sel.head } : { kind: "selection", from: sel.from, to: sel.to },
    };
  }
  const res = await commands.consoleRun(tabId, request);
  if (res.status === "error") return notify(runErrorText(res.error)); // Busy | NoStatement | BadFilter | Connect
  if (request.kind === "script") flashRanges(tabId, res.data.statements); // UTF-16 doc ranges actually executed
  // Progress, results, errors arrive as AppEvent::ConsoleChanged / ConsoleOutput.
}
```

### Call site 3: the grid pulls a window of rows (features/results/ResultGrid.tsx)

```ts
const cache = rowCacheFor(meta.ref);                       // module-level RowCache per ResultRef
useSyncExternalStore(cache.subscribe, cache.getVersion);
void cache.ensure({ start: firstRow - PREFETCH, end: lastRow + 1 + PREFETCH }, rowCount); // 256-row pages via commands.resultPage
// header: category icon (key icon for a PK column) + meta.columns[c].name; type.display in the tooltip
// align:  isRightAligned(meta.columns[c].type.category)
// cell:   cache.get(r)?.[c]; null is SQL NULL, string is PG text output
await commands.resultExportCsv(meta.ref, path); // ResultsPane; Rust writes from its own buffer
```

### Call site 4: engine integration test (crates/engine/tests/pg.rs)

```rust
#[tokio::test]
async fn manual_tab_isolated_until_commit_and_abort_rolls_back() {
    let mut h = Harness::start().await;              // Engine on tmp dir + MemoryKeyStore + Docker PG (:5433)
    let a = h.sql_tab(TxnMode::Manual).await;
    let b = h.sql_tab(TxnMode::AutoCommit).await;
    let table = unique("public.t_iso");
    h.run_ok(b, &format!("create table {table} (id int)")).await;
    let state = h.run_ok(a, &format!("insert into {table} values (1)")).await;
    assert_eq!(state.txn, TxnState::Active);
    assert_eq!(h.scalar(b, &format!("select count(*) from {table}")).await, "0");
    h.engine.console_commit(a).await.unwrap();
    assert_eq!(h.scalar(b, &format!("select count(*) from {table}")).await, "1");
    // ...then the abort, rollback, and savepoint cases
}
```

## Shape

### Load-bearing decisions

1. **Values travel as PostgreSQL's own text output. Types travel separately as column metadata.** Each statement is `prepare`d, which is Parse+Describe without execution. That yields column `Type`s with custom names resolved. The statement then runs through `simple_query_raw`, which streams text-format rows. A cell is `string | null`.
   - No per-type decoders exist anywhere.
   - Unknown and extension types render exactly as psql shows them.
   - Type-aware rendering keys off `TypeCategory` on the column, not off the value.
   - Session `TimeZone` is set to the OS IANA zone on session open, so timestamptz text is local time.
2. **Rust owns result rows. The webview pulls windows.** A `ResultSet` is an append-only text arena filled by the run task. The grid requests `resultPage(ref, start, len)`. CSV export writes straight from the arena. The webview never holds more than a few pages, and the row-cap policy lives in one place. Sort and filter on a table tab do not touch the arena. They change the tab's `TableQuery` and re-run `TablePage`, so the engine sorts and filters. The value viewer is the `cell` overlay, opened from the grid. It reads a cut cell's full text with `result_cell` through `RowCache.loadFull`.
3. **One dedicated session per tab, opened lazily, plus one metadata session per database the instance needs.** No pool. A connection is an `Instance`: its *home* session is on the configured database, and it reads `pg_database` on connect. Every other database gets a `DbSlot` with its own lazily opened metadata session, because a Postgres session reads only its own database's catalog. A slot exists exactly for the databases the tree shows and the databases this connection's consoles target; `reconcile` converges the slots to that set after connect, `console_configure`, and `console_close`, and `catalog_get` refuses any other database with `NotShown`. The home session's death marks the connection `Lost`; another slot's death fails only that database, and the next load reopens it. A slot's session also serves `exact_row_count` for its database. Session state (search_path, temp tables, GUCs, transactions) belongs to the tab, which is what an IDE user expects.
4. **During a run, the session moves into the run task.** `Console` holds `Option<Session>`. A run takes it and gives it back when finished. Commit, rollback, or a second run while it is gone returns `Busy`. Concurrent use of one session cannot be expressed.
5. **Snapshots over deltas.** The backend emits whole `ConsoleState` and `ConnectionState` values with a monotonically increasing `rev`. The frontend's live store is a pure projection: `apply(event)` keeps the higher rev. This is idempotent and tolerant of event order. Only `ConsoleOutput`, the append-only output log, uses deltas.
6. **One SQL lexer, in Rust.** `split_statements` and `classify` are pure functions. They handle dollar quotes, `E''` strings, nested block comments, and quoted identifiers. They drive statement picking, transaction-state tracking, DDL-triggered catalog refresh, and synthesized command tags. The frontend sends the whole document plus a cursor or selection. All offsets crossing IPC are UTF-16 code units (CodeMirror's unit), and the conversion happens once at the boundary.
7. **One full-catalog snapshot per database, keyed by `DatabaseRef { connectionId, database }`, loaded in four queries.** It covers schemas, relations with `reltuples`, columns with PK flags, and functions. The tree, ⌘P fuzzy search, CodeMirror completion, and the PK lookups for table pages and staged edits are all derived from the catalog of the database they address; OIDs are never compared across databases. The connection snapshot is the single source of catalog versions: `ConnStatus::Connected.instance` lists every database with its `CatalogStatus` (`Idle`, `Loading`, `Ready { version }`, `Failed`), and the frontend fetches `catalog_get(db)` when the served version is newer than what it holds. `Failed` carries the last good catalog's version, and `catalog_get` keeps serving that catalog, so a failed reload shows its error in the tree beside the schemas it already had, with a Retry; the frontend drops only views whose database serves no version (`Idle`, `Loading`, or a `Failed` first load). Versions come from one engine-wide counter, so a reconnect never reissues one. Successful DDL schedules a refresh of the console's database; a slot's `RefreshGate` coalesces a burst into at most two loads.
8. **Contract generation.** Every IPC type lives in `crates/engine` with `#[derive(Serialize, Deserialize, specta::Type)]`. `src-tauri` registers commands with `tauri-specta` and adds `AppEvent` as a plain exported type; the shell forwards `Engine::subscribe()` with `app.emit("app-event", ev)`, which sidesteps the release-candidate event API. Debug builds export `src/ipc/bindings.ts`, and a test fails if the checked-in file differs.
9. **SQL text is interpreted only in Rust.** That includes table-browse SQL: `RunRequest::TablePage` makes the engine build `SELECT * FROM "schema"."table" WHERE <filters> ORDER BY <user order>, <pk> LIMIT n OFFSET m` with its own identifier and literal quoting and the catalog's PK columns. The user's `WHERE` and `ORDER BY` text goes in as written, and the engine refuses the page if the result isn't one statement. Staged row edits go through `table_apply`, which builds the `INSERT`, `UPDATE`, and `DELETE` statements the same way.

### Rust types (crates/engine/src/model.rs, the IPC contract)

```rust
// ---- identity ---------------------------------------------------------------
#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct ConnectionId(pub Uuid);
#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct TabId(pub Uuid);           // minted by the frontend (crypto.randomUUID)
#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct RunId(pub u64);            // engine-wide monotonic
/// UTF-16 code-unit offset into the editor document as sent in RunRequest.text.
#[derive(Clone, Copy, Serialize, Deserialize, Type)] pub struct DocOffset(pub u32);
#[derive(Clone, Copy, Serialize, Deserialize, Type)] pub struct DocRange { pub from: DocOffset, pub to: DocOffset }

// ---- connection config --------------------------------------------------------
#[derive(Clone, Serialize, Deserialize, Type)]
pub enum SslMode { Disable, Prefer, Require, VerifyCa, VerifyFull }

/// Persisted (SQLite). Never contains the password.
#[derive(Clone, Serialize, Type)]
pub struct ConnectionConfig {
    pub id: ConnectionId, pub name: String, pub host: String, pub port: u16,
    pub database: String, pub user: String, pub ssl_mode: SslMode,
    pub ca_cert_path: Option<String>, pub has_password: bool, pub color: Option<String>,
}
/// Edit semantics for the secret are explicit; the frontend never reads a password back.
#[derive(Deserialize, Type)]
pub enum PasswordInput { Keep, Set(String), Clear }
#[derive(Deserialize, Type)]
pub struct ConnectionDraft {
    pub id: Option<ConnectionId>,      // None = create
    pub name: String, pub host: String, pub port: u16, pub database: String,
    pub user: String, pub ssl_mode: SslMode, pub ca_cert_path: Option<String>,
    pub password: PasswordInput, pub color: Option<String>,
}

// ---- live connection --------------------------------------------------------
#[derive(Clone, Serialize, Type)]
pub struct ServerInfo { pub version: String /* "16.4" */, pub version_num: u32, pub encoding: String }

#[derive(Clone, Serialize, Type)]
#[serde(tag = "kind")]
pub enum ConnStatus {
    Disconnected,
    Connecting,
    Connected { server: ServerInfo, instance: InstanceState },
    Failed { error: ConnectError },          // connect attempt failed
    Lost { reason: String },                 // the home database's metadata session died after being Connected
}
/// Every `pg_database` row with the state of its catalog. The single source of catalog versions.
#[derive(Clone, Serialize, Type)]
pub struct InstanceState { pub home: String, pub databases: Vec<DatabaseState> }
#[derive(Clone, Serialize, Type)]
pub struct DatabaseState { pub name: String, pub system: bool, pub access: DbAccess, pub shown: bool, pub catalog: CatalogStatus }
#[derive(Clone, Copy, Serialize, Type)] pub enum DbAccess { Ok, NoConnections, NoPrivilege }
#[derive(Clone, Serialize, Type)]
#[serde(tag = "kind")]
pub enum CatalogStatus { Idle, Loading, Ready { version: u64 }, Failed { message: String, version: Option<u64> } }  // Failed.version: the last good catalog, still served
#[derive(Clone, Serialize, Type)]
pub struct ConnectionState { pub id: ConnectionId, pub rev: u64, pub status: ConnStatus }

#[derive(Clone, Serialize, Type)]
#[serde(tag = "kind")]
pub enum ConnectError {
    Network { message: String }, Tls { message: String },
    Auth { message: String }, MissingPassword, Server(QueryError), Keychain { message: String },
}

// ---- catalog (one snapshot per database) ---------------------------------------
/// The key for every catalog read, refresh, and count. `database` is `pg_database.datname`.
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct DatabaseRef { pub connection_id: ConnectionId, pub database: String }
#[derive(Clone, Serialize, Type)]
pub struct Catalog { pub db: DatabaseRef, pub version: u64, pub schemas: Vec<SchemaInfo> }
#[derive(Clone, Serialize, Type)]
pub struct SchemaInfo { pub name: String, pub relations: Vec<Relation>, pub functions: Vec<FunctionInfo> }
#[derive(Clone, Serialize, Type)]
pub enum RelKind { Table, PartitionedTable, View, MaterializedView, ForeignTable }
#[derive(Clone, Serialize, Type)]
pub struct Relation {
    pub oid: u32, pub name: String, pub kind: RelKind,
    pub row_estimate: Option<i64>,         // None when reltuples = -1 (never analyzed)
    pub columns: Vec<ColumnInfo>,          // attnum order
}
#[derive(Clone, Serialize, Type)]
pub struct ColumnInfo { pub attnum: i16, pub name: String, pub type_display: String, pub not_null: bool, pub pk: bool }
#[derive(Clone, Serialize, Type)]
pub struct FunctionInfo { pub oid: u32, pub name: String, pub args: String, pub returns: String, pub kind: FnKind }
#[derive(Clone, Serialize, Type)] pub enum FnKind { Function, Procedure, Aggregate, Window }

// ---- console (one per tab) -------------------------------------------------------
#[derive(Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
pub enum TxnMode { AutoCommit, Manual }

#[derive(Clone, Deserialize, Type)]
pub struct ConsoleConfig { pub connection_id: ConnectionId, pub database: String, pub schema: Option<String>, pub mode: TxnMode }

#[derive(Clone, Copy, PartialEq, Serialize, Type)]
pub enum TxnState { Idle, Active, Aborted }   // Aborted: only ROLLBACK [TO SAVEPOINT] is accepted

#[derive(Clone, Serialize, Type)]
#[serde(tag = "kind")]
pub enum SessionState { None, Open { backend_pid: i32 }, Lost { reason: String, txn_lost: bool } }

#[derive(Clone, Serialize, Type)]
pub struct ConsoleState {
    pub tab_id: TabId, pub rev: u64, pub config: ConsoleConfigView,
    pub session: SessionState, pub txn: TxnState, pub run: RunState,
}
#[derive(Clone, Serialize, Type)]
pub struct ConsoleConfigView { pub connection_id: ConnectionId, pub database: String, pub schema: Option<String>, pub mode: TxnMode }

#[derive(Clone, Serialize, Type)]
#[serde(tag = "kind")]
pub enum RunState {
    Idle,
    Running  { run_id: RunId, started_at_ms: i64, statements: Vec<StatementRun> },
    Finished { run_id: RunId, elapsed_ms: u32, statements: Vec<StatementRun>, outcome: RunOutcome },
}
#[derive(Clone, Copy, Serialize, Type)] pub enum RunOutcome { Ok, Failed, Cancelled }

#[derive(Clone, Serialize, Type)]
pub struct StatementRun { pub index: u16, pub range: DocRange, pub status: StmtStatus }

#[derive(Clone, Serialize, Type)]
#[serde(tag = "kind")]
pub enum StmtStatus {
    Pending,
    Preparing,
    Rows { result: ResultMeta, done: bool },             // done=false while streaming
    Command { tag: String /* "UPDATE 3" */, elapsed_ms: u32 },
    Failed { error: QueryError },
    Cancelled,
    Skipped,                                             // an earlier statement failed or was cancelled
}

// ---- results ------------------------------------------------------------------
#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct ResultRef { pub tab_id: TabId, pub run_id: RunId, pub index: u16 }

#[derive(Clone, Serialize, Type)]
pub struct ResultMeta {
    pub r#ref: ResultRef,
    pub db: DatabaseRef,         // the database the rows came from; the grid's PK lookup keys on it, not on the tab's current target
    pub columns: Vec<ColumnMeta>,
    pub row_count: u32,          // rows stored and pageable
    pub rows_seen: u64,          // rows the server sent (> row_count when truncated)
    pub truncated: Option<TruncateReason>,
    pub elapsed_ms: u32,
}
#[derive(Clone, Copy, Serialize, Type)] pub enum TruncateReason { RowLimit, ByteLimit }

#[derive(Clone, Serialize, Type)]
pub struct ColumnMeta {
    pub name: String,
    pub r#type: PgTypeRef,
    pub source: Option<ColumnSource>,  // table_oid + attnum: the grid's PK icon (isPrimaryKey in state/catalog.ts)
}
#[derive(Clone, Serialize, Type)]
pub struct PgTypeRef { pub oid: u32, pub display: String /* "bigint", "integer[]", "order_status" */, pub category: TypeCategory }
#[derive(Clone, Copy, Serialize, Type)]
pub enum TypeCategory { Numeric, Text, Bool, Temporal, Json, Binary, Uuid, Network, Array, Enum, Composite, Range, Other }
#[derive(Clone, Copy, Serialize, Type)] pub struct ColumnSource { pub table_oid: u32, pub attnum: i16 }

/// Row-major page. Cells longer than `cell_char_limit` (default 2,000) are cut; their
/// coordinates are listed so the UI can mark them and fetch the full value on demand.
#[derive(Serialize, Type)]
pub struct RowPage { pub start: u32, pub rows: Vec<Vec<Option<String>>>, pub cut: Vec<(u32, u16)> }

#[derive(Clone, Serialize, Type)]
pub struct QueryError {
    pub severity: String, pub sqlstate: Option<String>, pub message: String,
    pub detail: Option<String>, pub hint: Option<String>, pub context: Option<String>,
    pub position: Option<DocOffset>,   // mapped from PG's 1-based char position into the document
}

// ---- output log (append-only) -------------------------------------------------
// Timestamped history of what the tab's session ran. Statement outcomes also live in
// ConsoleState.run: the snapshot is the current status, the log is the history.
#[derive(Clone, Serialize, Type)]
pub struct OutputEntry { pub at_ms: i64, pub run_id: RunId, pub body: OutputBody }  // the run, commit, rollback, or apply that held the session
#[derive(Clone, Serialize, Type)]
#[serde(tag = "kind")]
pub enum OutputBody {
    Statement { statement: u16, text: String },   // at statement start; text capped at 2,000 chars + "…"
    Rows { statement: u16, rows: u64, elapsed_ms: u32, truncated: bool },
    Command { statement: u16, tag: String, elapsed_ms: u32 },
    Notice { severity: String, message: String, detail: Option<String> },
    Error { statement: Option<u16>, error: QueryError },  // None: search_path, table_apply's transaction
    Info { message: String },          // "BEGIN (implicit)", "Session reset: connection lost (…)"
}

// ---- history, workspace, settings -------------------------------------------------
#[derive(Clone, Serialize, Type)]
pub struct HistoryEntry {
    pub id: i64, pub at_ms: i64, pub connection_id: ConnectionId, pub connection_name: String,
    pub database: String, pub sql: String, pub elapsed_ms: u32, pub outcome: HistoryOutcome,
}
#[derive(Clone, Serialize, Type)]
#[serde(tag = "kind")]
pub enum HistoryOutcome { Rows { rows: u64 }, Command { tag: String }, Error { message: String }, Cancelled }
#[derive(Deserialize, Type)]
pub struct HistoryQuery { pub text: Option<String>, pub connection_id: Option<ConnectionId>, pub before_id: Option<i64>, pub limit: u16 }
#[derive(Serialize, Type)] pub struct HistoryPage { pub entries: Vec<HistoryEntry>, pub has_more: bool }

/// Owned by the frontend, stored verbatim by the engine (single writer: the UI).
#[derive(Clone, Serialize, Deserialize, Type)]
pub struct Workspace { pub tabs: Vec<TabSnapshot>, pub active: Option<TabId>, pub layout: Layout }
#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind")]
pub enum TabSnapshot {
    Sql   { id: TabId, title: String, text: String, console: ConsoleConfigSnapshot },
    Table { id: TabId, connection_id: ConnectionId, database: Option<String>, schema: String, table: String, page: u32, #[serde(default)] query: TableQuery },
}
#[derive(Clone, Serialize, Deserialize, Type)]
pub struct ConsoleConfigSnapshot { pub connection_id: Option<ConnectionId>, pub database: Option<String>, pub schema: Option<String>, pub mode: TxnMode }
// `database` is `None` only in workspaces saved before tabs carried one; `tabFromSnapshot` resolves it to the connection's configured database.
#[derive(Clone, Serialize, Type)]
pub struct Layout {
    pub sidebar: bool, pub results: bool, pub right_panel: Option<RightPanel>, pub results_height: u16,
    pub sidebar_width: u16 /* 256 */, pub right_panel_width: u16 /* 341 */,
}
// Layout has a hand-written Deserialize: workspaces saved before the widths existed load with the defaults.
#[derive(Clone, Serialize, Deserialize, Type)] pub enum RightPanel { Assistant, Schema, History }
// Only Assistant is drawn. `restore` in state/workspace.ts maps any saved panel to Assistant.

#[derive(Clone, Serialize, Type)]
pub struct Settings { pub max_rows: u32 /* 200_000 */, pub max_result_bytes: u64 /* 512 MiB */, pub table_page_size: u32 /* 500 */, pub stop_on_error: bool, pub theme: Theme /* System */ }
#[derive(Clone, Copy, Default, Serialize, Deserialize, Type)] pub enum Theme { #[default] System, Light, Dark }
// Settings has a hand-written Deserialize: settings saved before `theme` existed load with Theme::System.

#[derive(Serialize, Type)]
pub struct BootSnapshot {
    pub connections: Vec<ConnectionConfig>, pub live: Vec<ConnectionState>,
    pub consoles: Vec<ConsoleState>, pub workspace: Workspace, pub settings: Settings,
}

// ---- the one event (emitted as "app-event") -------------------------------------
#[derive(Clone, Serialize, Type)]
#[serde(tag = "kind")]
pub enum AppEvent {
    ConnectionChanged(ConnectionState),                 // also carries every catalog version, in InstanceState
    ConsoleChanged(ConsoleState),                       // throttled to <= 10/s per console while streaming
    ConsoleOutput { tab_id: TabId, entries: Vec<OutputEntry> },
    HistoryAppended(HistoryEntry),
}
```

### IPC command list (src-tauri/src/ipc.rs)

Each command is one line delegating to `Engine`. tauri-specta uses `ErrorHandlingMode::Result`, so TypeScript sees `{status:"ok",data} | {status:"error",error}`.

| Command | Request | Response | Notes |
|---|---|---|---|
| `app_boot` | – | `BootSnapshot` | Idempotent. Safe after a webview reload because live consoles survive. |
| `connection_save` | `ConnectionDraft` | `Result<ConnectionConfig, SaveError>` | Upsert. Seals a set password and writes it before the config row. Reads the keychain only when a password is set. |
| `connection_delete` | `ConnectionId` | `Result<(), DisconnectError>` | Disconnects (refuses on open txns), deletes the config row and sealed password together. Never touches the keychain. |
| `connection_test` | `ConnectionDraft` | `Result<ServerInfo, ConnectError>` | `PasswordInput::Keep` opens the sealed password, if one is stored. |
| `connection_connect` | `ConnectionId` | `Result<ServerInfo, ConnectError>` | Idempotent. Opens the home session and reads `pg_database`; catalogs load afterwards, each with its own status. |
| `connection_disconnect` | `ConnectionId, force: bool` | `Result<(), DisconnectError>` | `OpenTransactions { tabs: Vec<OpenTxn> }` unless forced. |
| `catalog_get` | `DatabaseRef` | `Result<Catalog, CatalogError>` | Whole snapshot of one database, loaded on first use. `NotShown` for a database neither shown nor targeted by a console. |
| `catalog_refresh` | `DatabaseRef` | `Result<u64, CatalogError>` | Returns the new version. The connection snapshot carries it too. |
| `exact_row_count` | `DatabaseRef, schema: String, table: String, TableQuery` | `Result<u64, CountError>` | `count(*)` with the query's filters, on that database's metadata session. The pager's Last button calls it. |
| `console_configure` | `TabId, ConsoleConfig` | `Result<ConsoleState, ConfigureError>` | Upsert. `TransactionOpen` if mode, connection, or database change with a live txn. A connection or database change resets the session. A schema change issues `SET search_path` (applied on next run if busy). |
| `console_run` | `TabId, RunRequest` | `Result<RunAccepted, RunError>` | Returns once statements are picked. Progress arrives as events. `BadFilter` when a table page's SQL isn't one statement. |
| `console_cancel` | `TabId` | `()` | Idempotent. Sets the stop flag and sends `CancelRequest`. |
| `console_commit` | `TabId` | `Result<(), TxnError>` | `Busy`, `NoTransaction`. Commit in `Aborted` reports `RolledBack`. |
| `console_rollback` | `TabId` | `Result<(), TxnError>` | |
| `table_apply` | `TabId, TableChanges` | `Result<ApplySummary, ApplyError>` | Applies staged row edits on the tab's session, all or nothing. |
| `console_close` | `TabId, force: bool` | `Result<(), DisconnectError>` | Drops session and results. |
| `result_page` | `ResultRef, start: u32, len: u32` | `Result<RowPage, ResultError>` | `Gone` if the tab re-ran or closed. `len` ≤ 2,000. |
| `result_cell` | `ResultRef, row: u32, col: u16` | `Result<Option<String>, ResultError>` | Full value for cut cells. |
| `result_export_csv` | `ResultRef, path: String` | `Result<ExportSummary, ExportError>` | Path comes from `@tauri-apps/plugin-dialog` `save()`. RFC 4180, NULL as an empty field. |
| `history_list` | `HistoryQuery` | `HistoryPage` | Keyset pagination on id. |
| `history_clear` | – | `()` | |
| `workspace_save` | `Workspace` | `()` | Debounced 500 ms by the UI. Last write wins (single writer). |
| `settings_set` | `Settings` | `()` | |

```rust
#[derive(Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RunRequest {
    Script { text: String, target: RunTarget },
    /// Engine builds quoted SQL: the query's ORDER BY text first, then the catalog's PK columns as a tiebreak.
    TablePage { schema: String, table: String, page: u32, #[serde(default)] query: TableQuery },
}
#[derive(Clone, Default, PartialEq, Serialize, Type)]
pub struct TableQuery {
    pub order_by: String,              // SQL after ORDER BY; empty means primary key order
    pub filters: Vec<ColumnFilter>,
    pub r#where: String,               // a boolean SQL expression ANDed with `filters`; empty means none
}
// TableQuery has a hand-written Deserialize so saved tabs missing a field still load, while specta keeps every field required.
#[derive(Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ColumnFilter { pub column: String, pub op: FilterOp, pub value: String /* a PG literal; ignored by IsNull, NotNull */ }
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum FilterOp { Eq, Ne, Lt, Le, Gt, Ge, Contains, StartsWith, IsNull, NotNull }
#[derive(Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RunTarget { Cursor { offset: DocOffset }, Selection { from: DocOffset, to: DocOffset }, All, }
#[derive(Serialize, Type)]
pub struct RunAccepted { pub run_id: RunId, pub statements: Vec<DocRange> }
#[derive(Serialize, Type)]
#[serde(tag = "kind")]
pub enum RunError {
    Busy, NoStatement, NotConfigured, Unsupported { what: String /* COPY FROM STDIN / TO STDOUT */ }, Connect { error: ConnectError },
    BadFilter,                         // WHERE or ORDER BY isn't a single expression
}
#[derive(Serialize, Type)] #[serde(tag = "kind")] pub enum TxnError { Busy, NoTransaction, RolledBack, Query(QueryError) }
#[derive(Serialize, Type)] #[serde(tag = "kind")] pub enum ResultError { Gone, OutOfRange }
#[derive(Serialize, Type)] pub struct ExportSummary { pub rows: u64, pub bytes: u64, pub truncated: bool }
#[derive(Serialize, Type)] #[serde(tag = "kind")] pub enum CountError { NotConnected, Failed { message: String } }

/// Staged edits to one table. Rows to update or delete are found by primary key.
#[derive(Deserialize, Type)]
pub struct TableChanges {
    pub schema: String, pub table: String,
    pub inserts: Vec<Vec<CellWrite>>,  // columns left out take their default
    pub updates: Vec<RowUpdate>,
    pub deletes: Vec<Vec<CellWrite>>,  // each entry is the primary key of a row to delete
}
#[derive(Clone, PartialEq, Deserialize, Type)]
pub struct CellWrite { pub column: String, pub value: Option<String> /* PG text input; None is NULL */ }
#[derive(Deserialize, Type)] pub struct RowUpdate { pub key: Vec<CellWrite>, pub set: Vec<CellWrite> }
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Type)] pub enum ChangeKind { Insert, Update, Delete }
/// Points at one entry of `TableChanges`, by its list and index there.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Type)] pub struct ChangeRef { pub kind: ChangeKind, pub index: u32 }
/// `committed` is false when the changes wait in the tab's open transaction (manual mode) for Commit.
#[derive(Serialize, Type)] pub struct ApplySummary { pub committed: bool }
/// Nothing is applied when any of these comes back.
#[derive(Serialize, Type)]
#[serde(tag = "kind")]
pub enum ApplyError {
    Busy, NotConfigured, Connect { error: ConnectError },
    TransactionAborted,                              // roll the tab's failed transaction back first
    NoPrimaryKey,                                    // updates and deletes need the full primary key
    Failed { change: ChangeRef, error: QueryError },
    RowMismatch { change: ChangeRef, rows: u64 },    // matched `rows` rows instead of one
    Transaction { error: QueryError },               // opening or committing the transaction failed
}
```

Table data tabs need no extra command to read. A table tab sends `RunRequest::TablePage` with its `TableQuery` (`where`, per-column `filters`, `orderBy`) to `console_run` on its own console. The engine builds `SELECT * FROM "public"."orders" WHERE … ORDER BY <user order>, <pk cols> LIMIT 500 OFFSET 1000` with a pure, tested `browse_sql` function and then follows the same run path as a script. One execution path serves both tab kinds, and identifier quoting has one owner.

Writing uses one command, `table_apply(tab, TableChanges)`. It borrows the tab's session the way Commit and Rollback do, and runs deletes, then updates, then inserts. With no transaction open, auto-commit mode wraps them in `BEGIN … COMMIT`, and manual mode leaves them in a new open transaction. Inside an open transaction they run under a savepoint, so a failure leaves that transaction as it was. Rows to update or delete are found by their full primary key, and each statement must affect exactly one row. Otherwise everything rolls back, and the error names the change that failed.

### Engine (crates/engine/src/lib.rs, the deep module)

```rust
pub struct Engine { shared: Arc<Shared> }
pub(crate) struct Shared { /* data_dir, vault, store, settings, connections, consoles, events, next_run, timezone */ }

pub struct EngineConfig { pub data_dir: PathBuf, pub keys: Arc<dyn KeyStore> }

impl Engine {
    pub async fn open(cfg: EngineConfig) -> Result<Arc<Self>, StoreError>;   // opens SQLite, runs migrations
    pub fn data_dir(&self) -> &Path;                                         // self-check report, bridge log
    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent>;                // Tauri shell + tests
    pub fn boot(&self) -> BootSnapshot;

    pub async fn save_connection(&self, d: ConnectionDraft) -> Result<ConnectionConfig, SaveError>;
    pub async fn delete_connection(&self, id: ConnectionId) -> Result<(), DisconnectError>;
    pub async fn test_connection(&self, d: ConnectionDraft) -> Result<ServerInfo, ConnectError>;
    pub async fn connect(&self, id: ConnectionId) -> Result<ServerInfo, ConnectError>;
    pub async fn disconnect(&self, id: ConnectionId, force: bool) -> Result<(), DisconnectError>;
    pub async fn catalog(&self, db: DatabaseRef) -> Result<Arc<Catalog>, CatalogError>;
    pub async fn refresh_catalog(&self, db: DatabaseRef) -> Result<u64, CatalogError>;
    pub async fn exact_row_count(&self, db: DatabaseRef, schema: String, table: String, query: TableQuery) -> Result<u64, CountError>;

    pub async fn console_configure(&self, tab: TabId, c: ConsoleConfig) -> Result<ConsoleState, ConfigureError>;
    pub async fn console_run(&self, tab: TabId, r: RunRequest) -> Result<RunAccepted, RunError>;
    pub async fn console_cancel(&self, tab: TabId);
    pub async fn console_commit(&self, tab: TabId) -> Result<(), TxnError>;
    pub async fn console_rollback(&self, tab: TabId) -> Result<(), TxnError>;
    pub async fn table_apply(&self, tab: TabId, changes: TableChanges) -> Result<ApplySummary, ApplyError>;
    pub async fn console_close(&self, tab: TabId, force: bool) -> Result<(), DisconnectError>;

    pub fn result_page(&self, r: ResultRef, start: u32, len: u32) -> Result<RowPage, ResultError>;
    pub fn result_cell(&self, r: ResultRef, row: u32, col: u16) -> Result<Option<String>, ResultError>;
    pub async fn export_csv(&self, r: ResultRef, path: PathBuf) -> Result<ExportSummary, ExportError>;

    pub fn history(&self, q: HistoryQuery) -> HistoryPage;
    pub fn clear_history(&self);
    pub fn save_workspace(&self, w: Workspace);
    pub fn settings(&self) -> Settings;                                      // main.rs: the window's first theme
    pub fn set_settings(&self, s: Settings);
}
```

The surface is 27 methods. 23 of them match the 23 registered commands one to one. `open`, `data_dir`, `subscribe`, and `settings` serve the shell, the dev-bridge, and tests. Behind it the engine hides:

- TLS mode mapping and keychain reads
- Session lifecycle, lazy reconnects, and `search_path` / `TimeZone` setup
- Statement splitting and picking
- Implicit `BEGIN`
- Transaction-state tracking
- Prepare/describe and text streaming
- The row cap with drain
- Throttled snapshot emission
- History recording
- DDL-triggered catalog refresh, per database and coalesced
- UTF-16 offset mapping
- Table-browse, count, and edit SQL with its own quoting
- Staged edits applied under one transaction or savepoint

The frontend sequences two calls for one operation in two places only. `runTab` configures a tab's console before its first run, and the pager's Last button counts rows with `exact_row_count` before it loads the page.

### Internal structure

```rust
// console.rs
pub struct Console {
    pub tab: TabId,
    pub inner: Mutex<ConsoleInner>,                       // tokio Mutex, held only for state edits, never across a query
    pub results: std::sync::Mutex<Vec<Arc<ResultSet>>>,   // results of the current/last run only; dropped on re-run
    pub latest: std::sync::Mutex<ConsoleState>,           // the last published snapshot, for boot()
    pub closed: AtomicBool,
}
pub struct ConsoleInner {
    pub config: ConsoleConfigView,
    pub session: SessionSlot,
    pub txn: TxnState,
    pub run: RunState,
    pub rev: u64,
    pub owed: Owed,                                       // refreshes (catalog, database list) owed by statements whose transaction has not committed
}
pub enum SessionSlot {
    Empty,
    Idle(Session),
    Busy { run_id: RunId, backend_pid: i32, cancel: CancelHandle, stop: Arc<AtomicBool> },  // a run task or a commit owns the Session
    Lost { reason: String, txn_lost: bool },
}

// session.rs
pub struct Session {
    pub client: tokio_postgres::Client,
    pub backend_pid: i32,
    pub server: ServerInfo,
    pub search_path: Option<String>,              // the schema last set, compared with the console config before each run
    cancel: CancelToken,
    tls: MakeTlsConnector,
    notices: mpsc::UnboundedReceiver<DbError>,   // fed by the Connection driver task (poll_message)
    closed: watch::Receiver<Option<String>>,     // Some(reason) once the driver task exits
}
#[derive(Clone)] pub struct CancelHandle { token: CancelToken, tls: MakeTlsConnector }
impl Session {
    /// Connects, sets TimeZone, application_name='L1 Data', search_path; spawns the driver task.
    pub async fn open(p: &ConnectParams, schema: Option<&str>, timezone: &str) -> Result<Session, ConnectError>;
}

// results.rs: single writer (run task), many readers (result_page); append-only.
pub struct ResultSet { pub r#ref: ResultRef, pub columns: Vec<ColumnMeta>, data: RwLock<Arena> }
struct Arena { text: String, cells: Vec<(u32, u32)> /* (start, len); len == u32::MAX = NULL */, ncols: usize, rows_seen: u64, truncated: Option<TruncateReason>, elapsed_ms: u32 }

// sql/split.rs, sql/classify.rs: pure
pub struct StmtSpan { pub start: usize, pub end: usize }        // UTF-8 byte offsets, trimmed
pub fn split_statements(sql: &str) -> Vec<StmtSpan>;
pub fn pick(spans: &[StmtSpan], sql: &str, target: ByteTarget) -> Vec<StmtSpan>;
pub enum StmtKind {
    Begin, Commit, Rollback, Savepoint, RollbackTo, Release,
    Ddl(String), Dml(DmlVerb), Query, CopyStdio, NoTxnBlock(String), Other(String),   // String: the command tag
}
pub fn classify(stmt: &str) -> StmtKind;

// catalog.rs
impl Catalog { pub fn relation(&self, schema: &str, table: &str) -> Option<&Relation>; }
impl Relation { pub fn pk_columns(&self) -> Vec<String>; }

// txn.rs: pure, exhaustively tested
pub enum StmtOutcome { Ok, Err }
pub fn txn_after(state: TxnState, kind: &StmtKind, outcome: StmtOutcome) -> TxnState;
pub fn needs_implicit_begin(mode: TxnMode, state: TxnState, kind: &StmtKind) -> bool;

// text.rs: pure boundary conversions
pub struct OffsetMap<'a> { /* sql text */ }
impl OffsetMap<'_> {
    pub fn to_utf16(&self, byte: usize) -> DocOffset;
    pub fn from_utf16(&self, off: DocOffset) -> usize;
    pub fn range(&self, span: &StmtSpan) -> DocRange;
    /// PG ErrorPosition::Original(n) is a 1-based character index within the statement.
    pub fn pg_position(&self, stmt: &StmtSpan, n: u32) -> DocOffset;
}
pub fn type_ref(t: &tokio_postgres::types::Type) -> PgTypeRef;       // int8 -> bigint, _int4 -> integer[], Kind -> category
pub fn synthesize_tag(kind: &StmtKind, rows: u64) -> String;          // "INSERT 0 3", "UPDATE 3", "CREATE TABLE"
pub fn quote_ident(name: &str) -> String;
pub fn quote_literal(value: &str) -> String;
pub fn browse_sql(schema: &str, table: &str, pk: &[String], q: &TableQuery, limit: u32, offset: u64) -> String;
pub fn count_sql(schema: &str, table: &str, q: &TableQuery) -> String;
pub fn insert_sql(schema: &str, table: &str, cells: &[CellWrite]) -> String;
pub fn update_sql(schema: &str, table: &str, key: &[CellWrite], set: &[CellWrite]) -> String;
pub fn delete_sql(schema: &str, table: &str, key: &[CellWrite]) -> String;
```

### Run loop (console.rs, pseudocode)

```rust
async fn run_task(console: Arc<Console>, shared: Arc<Shared>, mut session: Session, plan: RunPlan, stop: Arc<AtomicBool>) -> Result<(), Orphaned> {
    // if session.search_path != plan.schema => session.set_search_path(plan.schema)
    for (i, stmt) in plan.statements.iter().enumerate() {
        if stop.load() { mark rest Cancelled/Skipped; break }
        let kind = stmt.kind;                            // classified by console_run
        output(Statement { i, text })                    // TablePage logs the SQL the engine built
        if needs_implicit_begin(mode, txn, kind) { session.client.batch_execute("BEGIN"); txn = Active; Info("BEGIN (implicit)") }
        set_status(i, Preparing);
        let outcome = match session.client.prepare(stmt.sql).await {
            Err(e) => Failed(map_err(e, stmt)),
            Ok(p) if p.columns().is_empty() => {
                // simple_query: collect CommandComplete(n) -> synthesize_tag(kind, n)
            }
            Ok(p) => {
                // result = ResultSet::new(ref, p.columns().map(column_meta))
                // stream = simple_query_raw(stmt.sql); for msg in stream:
                //   Row(r)              => if arena under caps { append text cells } else { rows_seen += 1 }  // drain, never cancel
                //   CommandComplete(n)  => done
                //   every 100ms         => emit ConsoleChanged (row_count grows)
            }
        };
        output(drained notices ++ [Rows | Command | Error])  // one ConsoleOutput: notices, then the result line
        txn = txn_after(txn, &kind, outcome.ok_or_err());
        shared.record_history(...);                      // single writer: run tasks, via store mutex
        if outcome.failed() && settings.stop_on_error { mark rest Skipped; break }
        if ok { owed.add(kind.invalidates()) }; if txn == Idle { shared.schedule_refreshes(console db, owed.take()) }  // inside a txn: owed until commit
    }
    // if session.closed has Some(reason): slot = Lost { reason, txn_lost: txn != Idle }; txn = Idle
    // else slot = Idle(session)
    // run = Finished { .. }; emit ConsoleChanged
}
```

Session-loss rules:

- **Death detection.** Driver-task exit, or TCP keepalive (`keepalives_idle = 30s`), sets `closed`.
- **Lost while idle with no transaction.** The next run opens a fresh session transparently and logs `Info("Session reset")`.
- **Lost with a transaction open.** The slot becomes `Lost { txn_lost: true }` and the UI shows a persistent banner: "Transaction rolled back: connection lost". The next run starts a fresh session and clears the banner.
- **Metadata session death.** The home database's session marks `ConnectionState` `Lost` and closes the instance, which drops every slot and its session. Another database's session marks only that database's `CatalogStatus` `Failed`, keeping the last catalog's version; the next load on it reopens the session. Consoles are independent. A disconnect closes the instance the same way, and a slot's watch task holds the instance weakly so it cannot keep a session alive past that.

`disconnect(force=false)` checks every console of that connection that is `Active` or `Aborted`. To compute `has_writes` it runs `SELECT pg_current_xact_id_if_assigned() IS NOT NULL` (PG13+, else `true`) on the idle session.

### Frontend (React 19, TypeScript, Vite)

- **Framework: React 19.** cmdk covers three palettes: catalog search (⌘P), query history, and settings search. Radix covers dialogs, dropdown menus, and context menus. TanStack Virtual covers the grid, and `@tabler/icons-react` supplies the icons. react-resizable-panels holds only the editor and results split. The right panel draws an Assistant placeholder. The AI chat is not built yet. Agents write React most reliably, which speeds the verify loop.
- **Editor: CodeMirror 6, used directly** (no wrapper library). One `EditorView` is mounted, and the `EditorState` is swapped per tab, so undo history survives tab switches. Table tabs get an editor too, seeded with `browseQuery(schema, table)`. `sql({ dialect: PostgreSQL, schema, upperCaseKeywords: true })` provides highlighting and schema completion. A second completion source, `qualifiedTables`, offers every table as `schema.table` and inserts `"schema"."table"`. After a failed script run, `showDiagnostics` calls `setDiagnostics` to mark `QueryError.position`.
- **Grid: a hand-built DOM grid on `@tanstack/react-virtual`.** Every row has the same height, `round((code font size + 11) × density factor)`, which is 24 px at the defaults. Column widths are measured in the chosen code and interface fonts. Rows and columns are always virtualized. The header is one line with a category icon (a key icon for a primary-key column) and the name. The type shows in the tooltip. On a table tab a header click sorts and Shift-click adds a sort key. A sticky row-number column is on the left. Numeric categories are right aligned with digit grouping, inserted textually so precision is never lost. NULL renders as a dim `NULL`. Cut cells show an ellipsis button that opens the `cell` overlay with the full value. Selection of a cell range is copied as TSV, up to 50,000 rows. On an editable table tab the grid also edits cells, adds rows, and marks rows deleted (see Frontend phase in Implementation reconciliation).
- **Styling: Tailwind v4** with CSS variables for every colour. `index.css` holds the dark values from the mockup and a `:root[data-theme="light"]` block that overrides each one. The CodeMirror theme and syntax colours read the same variables. `shell/theme.ts` sets `data-theme` and `color-scheme` on the root element before the first render. It follows `prefers-color-scheme` while the setting is System. `shell/appearance.ts` paints the font, density, and motion settings the same way, as root custom properties. Tailwind's `--spacing` is `0.25rem × --density`, so every spacing utility follows the density. Interface text uses `text-ui-N` tokens, defined as `N px × --ui-scale`, instead of `text-[Npx]`. The SQL editor and the result grid cells use `--code-font` and `--code-size`. The side columns, Radix dialogs, and menus animate over `--panel-duration`.
- **Settings is a screen, not an overlay.** The workspace store holds `screen: { kind: "workspace" } | { kind: "settings"; section; target? }`, which is not persisted. There is one sidebar. `Sidebar` always draws its header (the sidebar toggle and the app title) and picks its body from `screen.kind`. In settings the body is `SettingsSidebarBody`: a "Search" row, the section list, and a Back button at the bottom. The main panel shows the section and the right panel is hidden. The sidebar toggle works as in the workspace. When the sidebar is hidden, the toggle sits at the leading edge of the settings page header. Sections come from the `SETTINGS_SECTIONS` registry in `features/settings/sections.tsx`, and each section lists its settings with a label and search keywords. The settings search (`⌘P` while settings is open) ranks those settings with the catalog search's fuzzy ranker. Choosing one opens its section with `target` set, and the page scrolls to the element marked `data-setting="<id>"` and focuses its control. Each change applies and persists at once. Escape closes an open settings search first. The Back button, Escape, and `⌘,` return to the workspace. Any other shortcut that opens an overlay or a tab returns to the workspace first. Entering or leaving settings closes any open overlay, so no dialog carries over to the other screen.

Stores (Zustand v5). Each has one owner, and derived data is never stored:

```ts
// state/live.ts: pure projection of backend events. No component writes here.
type LiveData = {
  connections: Record<ConnectionId, ConnectionState>;
  consoles: Record<TabId, ConsoleState>;
  output: Record<TabId, OutputEntry[]>;                // ring buffer, 5,000 per tab; the Output panel renders all of it
  historyTail: HistoryEntry[];                         // last 200 HistoryAppended entries, newest first
};
// wantedCatalogs(connections): every Ready catalog of every Connected instance, keyed by DbKey (connection id + NUL + database).
// boot.ts prunes useCatalog to that set and calls ensure for each entry.
type LiveState = LiveData & {
  hydrate(b: BootSnapshot): void;
  apply(e: AppEvent): void;                            // keep-higher-rev; exhaustive switch on e.kind
};
// export const useLive = create<LiveState>()(...)

// state/workspace.ts: UI-owned; tabs, order, active, and layout persist via workspace_save (debounced)
type ConsoleTarget = { db: DatabaseRef | null; mode: TxnMode };   // a tab never names a connection without a database
type Tab =
  | { kind: "sql"; id: TabId; title: string; console: ConsoleTarget }
  | { kind: "table"; id: TabId; db: DatabaseRef; schema: string; table: string; page: number;
      query: TableQuery; exactRowCount?: number };    // exactRowCount: set by the pager's Last button
type WorkspaceData = {
  tabs: Record<TabId, Tab>; order: TabId[]; active: TabId | null; layout: Layout;
  configs: Record<ConnectionId, ConnectionConfig>;
  activeResult: Record<TabId, number>;                 // which statement's result is shown
  settings: Settings;
  selected: RelationRef | null;                        // highlighted relation in the tree: { db, schema, relation }
  overlay: Overlay;                                    // none | palette | history | settings-search | connection | cell | confirm
  screen: Screen;                                      // workspace | settings
  toast: { id: number; text: string } | null;
  cursor: { line: number; col: number };               // status bar Ln/Col
};
// Editor text lives only in CodeMirror: editorStates: Map<TabId, EditorState> (module-level).
// workspaceSnapshot() reads SQL tab text from there. No second copy of the text is kept.

// state/catalog.ts: per database, rebuilt when its catalog version changes
type CatalogView = {
  catalog: Catalog;
  completion: SQLNamespace;                            // {schema: {table: [cols]}} for lang-sql
  qualifiedTables: Completion[];                       // "schema.table", applied as "schema"."table"
  searchItems: SearchItem[];                           // tables, views, functions, "table.column"; each carries its DatabaseRef
  relationsById: Map<number, { schema: string; rel: Relation }>;   // OIDs are per database, so per view
};
// useCatalog: { views: Record<DbKey, CatalogView>; ensure(ref, version): Promise<void>; prune(keep: Set<DbKey>): void }

// state/rowCache.ts: outside React, per ResultRef, LRU of 256-row pages (max 64 pages)
class RowCache {
  constructor(ref: ResultRef, source?: RowSource);    // source defaults to result_page / result_cell
  get(row: number): Row | undefined;
  isCut(row: number, col: number): boolean;
  ensure(range: RowRange, rowCount: number): Promise<void>;
  loadFull(row: number, col: number): Promise<string | null | undefined>;   // result_cell
  subscribe(listener: () => void): () => void;        // with getVersion, for useSyncExternalStore
}
function rowCacheFor(ref: ResultRef): RowCache;        // module-level map; a new runId for a tab evicts its old caches
function dropRowCaches(tabId: string): void;

// state/tableEdits.ts: staged row edits per table tab, not persisted
// useTableEdits: { byTab: Record<TabId, TableEdits>; submitting: Record<TabId, true>; edit; addRow; clear; beginSubmit; endSubmit }
type TableEdits = {
  inserts: NewRow[];
  updates: Record<RowKey, { key: CellValue[]; values: Record<string, CellValue> }>;  // RowKey = JSON of the PK values
  deletes: Record<RowKey, CellValue[]>;
  failedAt: { insert: number } | { key: RowKey } | null;
};

// features/results/tableQuery.ts: useFilterDrafts, filter rows the user is still filling in, per tab
// state/status.ts: pure derivations (isRunning, hasUncommittedWork, connectionStatus, shownResult, runSummary)
```

The UI derives its status values instead of storing them:

| Derived status | Source |
|---|---|
| Run button: Run or Cancel | `isRunning(consoles[tab])`, from `run.kind` |
| Status bar | `connectionStatus(connections[id])`, the server version, a "Transaction rolled back: connection lost" chip while `session` is `Lost { txnLost }`, Ln/Col on SQL tabs, and the mode menu on SQL tabs (table tabs show a fixed auto-commit chip) |
| Commit/Rollback visibility | SQL tabs only, while `hasUncommittedWork` (`config.mode === "Manual" && txn !== "Idle"`) |
| "6 rows · 38 ms" in the results toolbar (`result-status`) | `runSummary(run, picked, now)` from `ResultMeta` |
| Unsaved dot | Shown only while `txn !== "Idle"` in manual mode ("uncommitted work"). Consoles autosave text to the workspace, so a text-dirty dot would mean nothing. |

### Persistence

Everything lives under `app_data_dir()` (override with `L1_DATA_DATA_DIR` in debug builds), in one SQLite file `l1-data.sqlite3` (rusqlite, bundled, WAL journal) with `PRAGMA user_version` migrations:

- `connections(id TEXT PK, json TEXT)`. Configs only.
- `history(id INTEGER PK, at_ms, connection_id, connection_name, database, sql, elapsed_ms, outcome_json)`, indexed on `(connection_id, id)`. Search is `LIKE`; FTS5 can come later. Pruned to the newest 10,000 entries on insert.
- `kv(key TEXT PK, json TEXT)`. Holds `workspace` and `settings`.
- `secrets(connection_id TEXT PK, nonce BLOB, ciphertext BLOB)`. One sealed password per connection. Migration 2 adds it.

The OS credential store holds one item, a random 32-byte master key, with service `dev.l1data.app` and user `master-key`. macOS therefore asks for keychain access once, not once per connection. Each password is sealed with XChaCha20-Poly1305 under that key, with a random nonce and the connection id as associated data, and the result is stored in the `secrets` table. All passwords do not go into one keychain item because Windows Credential Manager caps an item at 2560 bytes. The first saved password creates the key. Reading a password never creates one. If the key is missing or a password fails to open (wiped keychain, copied data dir, memory store restart), the connection behaves as if it had no password, and the user enters it again at the `MissingPassword` prompt. `trait KeyStore { load, save }` has two implementations: `KeyringKeyStore` and `MemoryKeyStore`. The second exists for tests and e2e, selected by `L1_DATA_SECRET_STORE=memory` in debug builds only. SQLite access is a `std::sync::Mutex<rusqlite::Connection>`. Writes are single-row and sub-millisecond, so they run inline.

### Repo layout

```
Cargo.toml                    # workspace: crates/engine, crates/dev-bridge, src-tauri
package.json  vite.config.ts  tsconfig.json  index.html
README.md  AGENTS.md  CLAUDE.md   # AGENTS.md holds instructions for coding agents; CLAUDE.md imports it
crates/engine/
  src/lib.rs                  # Engine facade
  src/model.rs                # every IPC type (single source)
  src/connection.rs           # ConnectParams, TLS (postgres-native-tls), Live/ConnSlot/ConnEntry, metadata session, draft_from_url
  src/session.rs              # Session: client + driver task + notices + death watch; CancelHandle
  src/console.rs              # Console, SessionSlot, run task
  src/txn.rs                  # pure transaction state machine
  src/sql/{mod,split,classify}.rs  # pure lexer, picker, classifier
  src/text.rs                 # UTF-16 mapping, type_ref, synthesize_tag, quoting, browse/count/edit SQL
  src/results.rs              # Arena, pages, CSV writer
  src/catalog.rs              # 4 catalog queries -> Catalog
  src/store.rs                # SQLite: migrations, connections, history, kv, secrets
  src/secrets.rs              # Vault + KeyStore (Keyring/Memory)
  tests/pg.rs                 # pg-tests feature: Harness + every scenario
src-tauri/
  src/main.rs                 # builder, specta export, event forwarder task, plugins, macOS menu, self-check
  src/ipc.rs                  # #[tauri::command] one-liners
  build.rs  tauri.conf.json  capabilities/default.json
  app-icon.svg  icons/        # icons/ is generated from app-icon.svg by dev/icons.sh
src/                          # frontend
  main.tsx  boot.ts  index.css
  ipc/bindings.ts             # GENERATED, checked in
  ipc/errors.ts               # typed IPC errors -> user-facing text
  state/{live,workspace,catalog,rowCache,status,tableEdits}.ts
  shell/{AppLayout,TopBar,StatusBar,TabBar,Overlays,RightPanel,PixelColumn,ResizeHandle,WindowChrome,WindowEdgeActions}.tsx
  shell/{theme,hostedWindow,commands}.ts
  ui/primitives.tsx           # shared buttons, menus, dialogs, context menus
  features/settings/{sections,SettingsScreen,SettingsSearchPalette,SettingsSidebarBody,AppearanceSection,QueriesSection}.tsx
  features/sidebar/{Sidebar,SidebarSearch,ConnectionTree,SearchPalette}.tsx  features/sidebar/fuzzy.ts
  features/connections/{ConnectionDialog.tsx,connectionActions.ts}
  features/editor/{SqlEditor.tsx,editorStates.ts,runActions.ts,sqlIdent.ts,theme.ts}
  features/results/{ResultsPane,ResultGrid,FilterBar}.tsx  features/results/{format,tableQuery}.ts
  features/history/{HistoryPalette.tsx,historyList.ts}
  testing/shopCatalog.ts      # catalog fixture for vitest
  **/*.test.ts(x)             # vitest, next to the code under test
crates/dev-bridge/             # bin (not shipped): axum on 127.0.0.1:7077, POST /invoke/:cmd + GET /events (SSE)
src/dev/bridgeShim.ts         # loaded only in vite dev outside Tauri: mockIPC -> fetch, SSE -> emit("app-event")
dev/{docker-compose.yml,seed.sql}   # shop + lab.type_zoo
dev/bridge-smoke.sh           # curl flow against the dev-bridge
dev/screenshot.sh             # macOS: captures the real app into docs/images/l1-data.png
dev/icons.sh                  # regenerates src-tauri/icons
docs/architecture.md  docs/images/
```

Tracing a run from the button to the grid takes four files: `runActions.ts` → `ipc.rs` → `console.rs` → `live.ts`.

### Verification strategy (what an agent runs)

1. **Pure Rust units** (`cargo test -p engine`, no DB):
   - splitter: dollar quotes, `E'\''`, nested comments, `;` in identifiers, `BEGIN ATOMIC` bodies
   - `browse_sql` quoting of `"we""ird"` identifiers
   - picker: cursor in gaps or at end of doc
   - `txn_after`: every transition in a table test
   - `OffsetMap`: emoji and CJK before the error
   - `type_ref` alias table, `synthesize_tag`, arena paging, CSV quoting
   - classifier: transaction control, CTEs and comments before the verb, `CopyStdio` and `NoTxnBlock`, command tags
   - `browse_sql`: the ORDER BY text before the PK tiebreak, the WHERE text ANDed with column filters, every `FilterOp` with `LIKE` wildcards escaped
   - edit SQL (`insert_sql`, `update_sql`, `delete_sql`): quoted names and values, NULL written as `NULL` or `IS NULL`
   - secrets: seal and open, a reopened vault, one key read per vault, a password sealed for another connection, a lost key, concurrent first seals
   - store: migrations run once, history paging and pruning
   - model: wire casing, `RunRequest` tags, the nested `ConnectError` tag, settings and layouts saved by older versions still load
   - `Engine` without a DB: boot on an empty dir, passwordless saves never touch the keychain, persistence across `open`, draft validation
2. **Engine against real Postgres** (`pnpm db:up && cargo test -p engine --features pg-tests`). `Harness` uses `MemoryKeyStore`, a temp data dir, and `L1_DATA_TEST_PG` (default `postgres://l1data:l1data@localhost:5433/shop`). Scenarios:
   - connect reports a 16.x server version
   - catalog of `shop` contains the mockup's tables with PKs and estimates after `ANALYZE`
   - every `lab.type_zoo` cell equals Postgres's own text output: numeric, timestamptz, interval, json/jsonb, int[], text[], bytea, uuid, inet, enum, point, range, NULL
   - mockup query returns 6 rows with `orders: bigint`
   - multi-statement run yields `UPDATE n` tags, and the output log reads Statement, notices, result line for each statement, all with the run's id
   - a notice a deferred trigger raises at `COMMIT` is logged between the commit's `Statement` and `Command` lines, with the commit's run id
   - a statement's logged text is cut at 2,000 chars with `…`
   - error position maps to the right UTF-16 offset
   - cancel `pg_sleep(30)` finishes `Cancelled` in under 2 s
   - manual isolation and commit (call site 4); error leads to `Aborted`, then rollback leads to `Idle`
   - `pg_terminate_backend` of a console pid gives `Lost { txn_lost }`
   - `generate_series(1, 300000)` truncates at `max_rows` with `rows_seen = 300000`
   - CSV export equals `COPY ... TO STDOUT CSV` output
   - history persists across `Engine::open` on the same dir
   - DDL refreshes the catalog and the connection snapshot carries the new version; a DDL burst behind a busy metadata session causes exactly two loads
   - a table page on a second database (`reporting`) orders by that database's primary key; catalog versions keep rising across a reconnect; history records the console's database; a database no tab or tree row uses gets `NotShown`
   - `exact_row_count` is exact, reports `NotConnected` before connect, and fails on a missing table
   - a forced disconnect during a manual run leaves the tab idle, and a run orphaned by disconnect never writes into the next run
   - the console's schema sets `search_path`, `COPY ... FROM STDIN` and `TO STDOUT` are rejected as `Unsupported`, and the session survives
   - bad credentials fail with `Auth`, and `test_connection` works
   - `table_apply` commits every change or none, and in manual mode waits for Commit while a failure keeps the open transaction
   - table pages sort and filter in the engine
   - SQL comments in WHERE and ORDER BY keep the page limit
3. **Frontend units** (`pnpm test`, vitest, 16 files):
   - `live.apply` rev ordering and exhaustiveness
   - numeric grouping on text (`-1234567.890` → `-1,234,567.890`), page labels, elapsed time, TSV
   - catalog → `SQLNamespace` and search items, fuzzy ranking
   - `RowCache` page math
   - status derivations, workspace snapshot round trips (old table tabs without a query, dropped schemas), restore mapping any saved right panel to Assistant
   - staged edits → `TableChanges`, and edits held still while a submit is in flight
   - header sort cycling and the `ORDER BY` text round trip
   - browse-query quoting and serialized settings writes in `runActions`
   - grid header icons and key navigation, history list paging, settings screen, window chrome, theme, global shortcuts, the bridge shim
4. **Contract drift**: a `src-tauri` test (`export_bindings_up_to_date`) renders bindings to a string and asserts equality with `src/ipc/bindings.ts`. A second test asserts the dev-bridge dispatch table covers exactly the registered command names. The dev-bridge also tests that `app_boot` replies with the snapshot and that bad requests are bridge errors, not command errors.
5. **UI against the real engine** (`pnpm bridge`). `crates/dev-bridge` hosts the same `Engine` (MemoryKeyStore, temp `L1_DATA_DATA_DIR`) behind `POST /invoke/:cmd` and an SSE stream of `AppEvent`. In vite dev outside Tauri, `src/dev/bridgeShim.ts` installs `mockIPC` from `@tauri-apps/api/mocks` (with `shouldMockEvents`) that forwards every command to the bridge and re-emits SSE frames as `app-event`. The generated bindings run unchanged. An agent drives it with agent-browser or Playwright, selecting by `data-testid`:
   - create connection via the dialog, test it, save it, and see "Live" plus `customers 18.4k`-style estimates in the tree
   - ⌘P "ord it" opens `order_items`; the table tab shows 500 rows
   - new tab: type the mockup query, ⌘↵, see status "6 rows ·", the `orders` header tooltip `orders bigint`, right-aligned numbers
   - run `select slow_echo(30)`, click Cancel, see the results status show `Cancelled · …`
   - switch to Manual: insert, then a second tab's count is unchanged; Commit, and the count changes
   - reload the page: tabs, text, and history are restored
6. **Real shell.** `pnpm self-check` launches the debug binary with `L1_DATA_SELF_CHECK=1`: it boots `Engine` inside Tauri, connects to the dev DB, runs `SELECT 1` and loads the catalog, prints JSON, and exits 0. `pnpm screenshot` covers WKWebView rendering on macOS. It starts a throwaway Postgres, seeds a workspace through the dev-bridge, launches the debug app on that data dir, and captures its window with `screencapture` into `docs/images/l1-data.png`. Driving the real webview with `@wdio/tauri-service` (embedded provider, verified to support macOS) is not built.

## Synthesis decision

Arena over three runners (opus, fable, sonnet), cross-judged by fable. Base: the opus candidate, scored 29/30 by the judge against 21 for each of the others, and picked independently by the orchestrator. It was the only candidate right on all three load-bearing questions: server text output for every value (no per-type decoders), the session moving into the run task so concurrent use cannot be expressed, and a row cap that drains instead of cancelling so a big SELECT cannot abort a manual transaction.

Grafted:
- From sonnet: the dev-bridge plus `mockIPC` shim, so an agent drives the real UI against the real engine from a browser; the `L1_DATA_SELF_CHECK` shell smoke; history pruning at 10,000 entries; splitter cases for `BEGIN ATOMIC` bodies and a cursor in trailing whitespace; events as a plain specta type sent with `app.emit`.
- From fable: table-page SQL built in Rust (`RunRequest::TablePage`), so SQL text has one interpreter; elapsed time measured around execution only, excluding the describe round trip.

Rejected:
- Sonnet's binary decoder: an open-ended surface with hex fallback for unknown types. Its cap-hit `cancel_query` also aborts a manual transaction while reporting success.
- Fable's rows-into-JS streaming: it holds every result twice, puts 50k rows in the WebKit heap, and lets cap and export policy leak into the frontend.
- Fable's character offsets: CodeMirror sends UTF-16 units, so positions need the explicit `OffsetMap` mapping.
- `@wdio/tauri-service` as the v1 e2e path: kept as the next step. The bridge works with the browser tooling agents already have, and the shell smoke plus a screenshot cover the Tauri-specific gap.

## Tradeoffs accepted

- **Prepare costs a round trip.** We accept two round trips per statement (Parse/Describe, then simple-protocol execute) in exchange for exact PG text output plus full column type metadata, with zero per-type decoders. Displayed elapsed time excludes the describe.
- **Values are text, not typed JSON.** Future client-side sort or charts must parse text by `TypeCategory`. Numeric precision is never silently lost, and unknown types always render.
- **One connection per open tab.** Ten tabs means ten backends. We accept that in exchange for faithful per-tab session semantics. An idle-session reaper can come later.
- **The row cap drains instead of cancelling.** This avoids aborting a manual transaction because a SELECT was large. A huge accidental result keeps the network busy until it finishes or the user presses Cancel.
- **Command tags are synthesized** from the classified verb and the row count, because tokio-postgres doesn't expose the textual tag. Exotic tags (`SELECT 0` from `CREATE TABLE AS`) may read slightly differently from psql.
- **The catalog loads eagerly per connection.** Search, completion, and the tree become trivial. A database with hundreds of thousands of columns makes a multi-MB snapshot (see risks).
- **Snapshots cost more bytes per event than deltas.** We accept that for an idempotent, order-tolerant frontend projection with no merge logic. Streaming snapshots are throttled to 10/s.
- **`ipc.rs` is a pass-through layer.** It is kept only as the IPC adapter: State extraction, specta registration, and error typing. The engine crate builds and tests without Tauri or WebKit.
- **Results die on re-run.** No pinned result tabs in v1. `ResultRef.run_id` makes stale page requests return `Gone` rather than wrong rows.

## Alternatives considered

- **Ship every row to the webview** (JSON or Arrow, columnar, capped). This makes the backend simpler. But the cap, memory, and export policy all leak into the frontend, export round-trips the data back through IPC, and a 200k-row result lives in WebKit's heap. The interface looks smaller, but the caller ends up owning the hard part.
- **Binary protocol with tagged typed values** (`{ kind: "numeric", value: "..." } | { kind: "array", items: [...] }`). This needs a decoder per PG type with a never-ending tail, and every type renders differently from psql. It exposes PG's wire representation on the public contract.
- **sqlx with `raw_sql`.** This gives text values and type info in one round trip, but sqlx cannot send a CancelRequest, and Cancel is a v1 requirement.
- **A shared pool (deadpool) for auto-commit tabs, with dedicated connections only for manual tabs.** Fewer connections, but `SET`, temp tables, and `search_path` silently vanish between runs. It also creates two session models that callers must understand.
- **Server-side cursors with fetch-on-scroll** (DataGrip style). This keeps memory bounded for arbitrary results, but it holds a transaction open in auto-commit tabs and conflicts with manual-mode semantics. Worth revisiting behind the same `result_page` API if the cap proves too small.
- **Per-run Tauri `Channel` for progress, with global events for status.** This would give two delivery mechanisms and two reducers. One global `AppEvent` with snapshots is simpler, and nothing is high-frequency enough to need a channel because rows never travel in events.
- **Monaco, glide-data-grid, Solid.** Monaco is heavy, its SQL support is generic, and it needs worker setup in Tauri. glide-data-grid is canvas-based: it is harder to theme to the mockup and has weaker text selection, and DOM virtualization is already fast enough because rows arrive windowed. Solid's fine-grained reactivity buys little when the grid is window-fetched, and it gives up cmdk, Radix, and agent fluency.

## Implementation reconciliation

Scaffold phase (workspace, contract, shell, dev-bridge, frontend skeleton). Each item is a place the code differs from or adds to the design above.

- **Wire casing.** Struct fields and struct-variant fields are camelCase on the wire (`rename_all = "camelCase"` on structs, `rename_all_fields = "camelCase"` on tagged enums). Enum tags keep the Rust variant name (`"Connected"`, `"Manual"`), except `RunRequest` and `RunTarget`, whose tags are camelCase (`"script"`, `"tablePage"`, `"cursor"`).
- **`RunError::Connect { error: ConnectError }`** replaces `Connect(ConnectError)`. Both enums are internally tagged on `kind`, so the newtype form serializes two `kind` keys and the inner one wins in JavaScript. `model::tests::nested_connect_error_keeps_its_own_tag` guards this.
- **`DisconnectError::OpenTransactions { tabs: Vec<OpenTxn> }`**, where `OpenTxn { tabId, hasWrites }` replaces the `(TabId, bool)` tuple, so the frontend reads a named field instead of a positional boolean.
- **Error types the design named but did not define:**
  - `SaveError` is `Invalid | Keychain | Store`, each with a `message`.
  - `DisconnectError` also has `Store`, for `connection_delete`.
  - `NotConnected` is `{ connectionId }`.
  - `ConfigureError` is `TransactionOpen | Busy | UnknownConnection`.
  - `ExportError` is `Gone | Io { message }`.
  - `StoreError` is Rust-only, because only `Engine::open` returns it.
- **Command parameter names** (the camelCase invoke keys) are `draft`, `id`, `force`, `schema`, `table`, `tabId`, `config`, `request`, `changes`, `resultRef`, `start`, `len`, `row`, `col`, `path`, `query`, `workspace`, and `settings`. `resultRef` replaces `ref` because `ref` is a Rust keyword.
- **`console_cancel` takes `AppHandle`, not `State`.** Tauri requires async commands that borrow `State` to return `Result`, and `console_cancel` returns `()`.
- **Pins.** tauri-specta `=2.0.0-rc.25` requires specta `=2.0.0-rc.25` and specta-typescript `=0.0.12`. Bindings use `dangerously_cast_bigints_to_number()`, so `u64` and `i64` (revs, run ids, row counts, epoch millis) export as `number`. All of them stay below 2^53.
- **Bindings regeneration.** Besides debug-build startup, `pnpm bindings` reruns `export_bindings_up_to_date` with `UPDATE_BINDINGS=1`, which rewrites the file without opening a window.
- **Dispatch coverage source.** The dev-bridge test parses the generated `bindings.ts`, not a hand-kept constant. The drift test already proves that file equals the Tauri registration. The test compares command names and camelCase argument names.
- **Dev-bridge protocol.** The route is `/invoke/{cmd}` (axum 0.8 path syntax). A command's own result is 200 `{status:"ok",data}` or 200 `{status:"error",error}`. An unknown command (404), bad argument (400), or engine panic (500) returns `{message}`, and the shim throws it as a real `Error`, so `typedError` rethrows instead of returning a typed error. The body is parsed as JSON whatever the content-type, so a bare `curl -d '{}'` works. `L1_DATA_DATA_DIR` overrides the bridge's temporary data directory.
- **Window creation.** The `main` window is declared in `tauri.conf.json` with `"create": false` and built in `setup`, so `L1_DATA_SELF_CHECK=1` runs without a window. The self-check prints `{"ok":false,...,"connect":{"status":"notImplemented"}}` and exits 1 until the engine phase adds the connect, `SELECT 1`, and catalog steps.
- **Window chrome.** On macOS, `main.rs` turns decorations back on with an overlay title bar and a hidden title. The native traffic lights sit over the sidebar header, and macOS handles resizing. On Windows and Linux, `tauri.conf.json` sets `decorations` to false, and the webview draws the resize edges and the minimize, maximize, and close buttons at the right of the toolbar. The toolbar and the sidebar header are drag regions on every platform. `hostedWindow()` returns `{ chrome: "native" }` on macOS, the custom controls elsewhere, and null in the dev-bridge browser, where no window controls show. The sidebar toggle leads whichever header touches the window's left edge. That is the sidebar header while the sidebar is open and the toolbar while it is hidden. `windowLeadingInset()` gives both headers the same left padding, so the toggle stays put. On macOS that padding clears the traffic lights. The "L1 Data" title follows the toggle on every platform. The window opens with the persisted theme, or no theme for System, so native chrome such as the traffic lights matches from the first frame. When that theme resolves to light, `main.rs` sets a white window background. `index.html` paints a `light-dark()` background for the same reason. `startTheme()` paints the document from the webview's `prefers-color-scheme` before the first render. After that, in the app window, each theme change awaits the window's `setTheme` before it repaints, because the webview reports the window's forced theme until then. Only the latest change repaints and then calls `setBackgroundColor`. In the browser, the repaint is immediate.
- **Engine additions.** `Engine::data_dir()` lets the self-check report and the bridge log show the directory in use. `KeyringKeyStore` and `MemoryKeyStore` are implemented, not stubbed, and sealed passwords are keyed by `ConnectionId`.
- **Panel sizes.** The sidebar and the right panel are plain columns on either side of the main area, with widths set in pixels from `layout.sidebarWidth` and `layout.rightPanelWidth`. They used to be react-resizable-panels panels, which kept each one as a share of the window, so their widths changed whenever the window resized. `PixelColumn` draws either column with its resize handle. The sidebar's handle sits on its right edge and the right panel's on its left. A drag updates the width live, clamps it (200 to 480 pixels for the sidebar, 260 to 560 for the right panel), and saves it once on release. ArrowLeft and ArrowRight on the focused handle move it 8 pixels and save each step. Dragging one column takes space from the main area only. The main area keeps at least 320 pixels. When the window is too narrow for both columns beside it, the right panel shrinks toward its minimum first and the sidebar after it, without changing the saved widths. A drag or arrow key starts from the drawn width, so a squeezed column follows the pointer with no jump. A vertical react-resizable-panels `Group` still holds the editor and the results, and saves the results height on release.
- **Defaults the design left open.** `Settings::default()` sets `stop_on_error: true` and `theme: System`. `Layout::default()` is sidebar and results shown, no right panel, `results_height: 320`, `sidebar_width: 256`, and `right_panel_width: 341`.
- **Fonts** come from `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono`, the variable-axis builds of the Fontsource packages. They are the default interface and code fonts. `themes/fonts.ts` lists the other choices, which are system fonts. The picker offers one only when a canvas width probe finds it installed, because WKWebView has no `queryLocalFonts`.

Engine phase (every `todo!()` in `crates/engine` filled in, self-check wired). The contract did not change; `src/ipc/bindings.ts` is byte-identical.

- **`Deserialize` on `ConnectionConfig` and `HistoryOutcome`.** The store round-trips both as JSON. Rust-only derives, no wire effect.
- **`StmtKind` carries the command tag.** `Ddl(String)` and `Other(String)` hold the tag Postgres would print (`CREATE TABLE`, `SET`, `TRUNCATE TABLE`), because tokio-postgres reports only a row count. `NoTxnBlock(String)` (`VACUUM`, `CREATE DATABASE`, `... CONCURRENTLY`, `ALTER SYSTEM`) is excluded from the implicit `BEGIN`. `COPY ... TO STDOUT` is `CopyStdio` too, since the simple protocol cannot carry it either. `UNION`/`INTERSECT`/`EXCEPT` and a leading parenthesis classify as `Query`.
- **Console state split for sync readers.** `Console.results` (std mutex) and `Console.latest` (the last published `ConsoleState`) sit next to the tokio-mutexed `ConsoleInner`, so `result_page`, `result_cell`, and `boot()` never take the async lock. The design's `SessionSlot::InRun` is `SessionSlot::Busy { run_id, backend_pid, cancel, stop }`. `console_commit`, `console_rollback`, and `table_apply` move the session through the same slot, so a run during a commit reports `Busy`.
- **Connections keep their entry.** `ConnSlot::Disconnected` replaces removal on disconnect, so `rev` stays monotonic across reconnects. Only `connection_delete` removes the entry.
- **Schema changes apply at the next run.** The run task compares the session's `search_path` with the console config and issues `SET search_path TO "<schema>"` (the schema alone) before the first statement. One path serves both the busy and the idle case. `SET TimeZone` failures (an OS zone Postgres does not know) are ignored.
- **A FATAL answer is a dead session.** `pg_terminate_backend` delivers `FATAL 57P01` to the statement in flight before the driver task sees EOF, so the run task treats any FATAL as a loss and waits up to 500 ms for the driver's reason. `Session::closed_reason` also consults `Client::is_closed`.
- **Cancel between statements.** The next pending statement is marked `Cancelled`, the rest `Skipped`, outcome `Cancelled`. A statement that fails with `57014` while the stop flag is set is `Cancelled`; the same code without the flag (a `statement_timeout`) is `Failed`.
- **Catalog and database-list refreshes after DDL in a transaction** wait for the commit (`owed` on the console), whether the commit is a `COMMIT` statement or `console_commit`. `ALTER DATABASE` inside a Manual-mode transaction therefore re-reads `pg_database` at commit, when the home session can see it.
- **`has_writes`** is probed by taking the idle session out of the slot like a run does, so the console lock is never held across the query; an aborted transaction or a busy session reports `true`.
- **A run task owns the tab only while the slot says so.** Every write a task makes to console state goes through `Console::edit(run_id, ..)`, which applies and publishes the edit only while `SessionSlot::Busy { run_id }` matches. Disconnect and close reassign the slot and finish the run themselves (statement in flight `Cancelled`, the rest `Skipped`, outcome `Cancelled`, `txn` Idle), send a `CancelRequest`, and the task gets `Orphaned` at its next write, stops, and drops its session.
- **CSV** uses CRLF records with a header row, quotes fields containing `"`, `,`, CR, or LF, writes NULL as an empty field and the empty string as `""`, which is `COPY ... CSV HEADER` modulo line endings. The pg test compares after normalizing CRLF.
- **Values are the output function's text**, so booleans are `t`/`f` as in psql. `bool::text` would say `true`; the type-zoo test's oracle is the simple protocol on an independent session, not `::text` casts.
- **`ServerInfo.version`** is the first token of `server_version` (`16.15` from `16.15 (Debian ...)`); the dev image is 16.15, not 16.4, so tests assert the `16.` prefix.
- **`engine::draft_from_url`** turns a `postgres://` URL into a `ConnectionDraft` for the self-check and the test harness.
- **Self-check report** is `{ ok, dataDir, report }` where `report` holds `server`, `select1` (rows and elapsed), and per-schema relation and function counts, or `{ step, error }` on failure with the typed error as JSON.
- **`dev/bridge-smoke.sh`** drives the dev-bridge with curl (save, connect, catalog, configure, run the mockup query, page) and asserts the SSE stream delivered the `Finished` snapshot with six rows.
- **Dev-bridge panic test** replaced: no command panics any more, so the test now checks that a typed error (`catalog_get` on an unknown id) comes back as a command error, not a bridge error.

Frontend phase (PRs #4 and #11 to #13). These PRs built the live store, the editor, the grid, table sort, filter, and edit, and the settings screen. Each item is a frontend decision the design above did not make.

- **Table tabs own an editor.** `openTableTab` and `boot` seed it with `browseQuery(schema, table)`. `runTab` sends `RunRequest::TablePage` only while `isBrowsing(tab)`, which means the editor text still equals that query (trimmed, one trailing `;` allowed). Edited text runs as a script, like a SQL tab, and the results hide the pager, sort, filters, and editing.
- **Consoles span the whole database.** The frontend always sends `schema: null`. `tabFromSnapshot` drops a schema saved on a SQL tab by older versions. Table consoles are always `AutoCommit`. Completion qualifies names instead (`qualifiedTables`).
- **Paging.** A page change is saved on the tab only after the engine accepts the run. A page request that arrives mid-run waits in `queuedPages`, and the latest one wins. Changing the page size in `saveSettings` reloads every table tab at page 0. The Last button calls `exact_row_count`, stores the count as `exactRowCount`, and jumps to the last page.
- **Sort is text.** `TableQuery.orderBy` holds the `ORDER BY` text. A header click parses it with `parseOrderBy`, cycles the column with `nextSort`, and writes it back with `formatOrderBy`. Shift-click adds a key. `FilterBar` above the grid edits the `WHERE` text, the `ORDER BY` text, and the column filters directly. `ORDER BY` text that `parseOrderBy` can't read as plain columns stays as written, and a header click then replaces it.
- **Staged edits.** `useTableEdits` holds edits per tab, with rows keyed by the JSON of their primary-key values. A grid is editable only on a browsing table tab whose relation is of kind `Table` and whose full primary key is among the result columns. Edits are locked while a submit is in flight. ⌘S, or the toolbar, calls `submitEdits`, which sends `table_apply` and reloads the page on success. On failure, `failedAt` maps the failing `ChangeRef` back to its row. Closing a tab with pending edits asks first.
- **Row caches are module-level.** `rowCacheFor` keys a `RowCache` by `ResultRef`, so a cache outlives the components that read it. The first cache for a new `runId` evicts the tab's older ones, and `closeTab` calls `dropRowCaches`.
- **Settings writes are serialized.** `saveSettings` updates the store first, so a second change builds on the first. Each `settings_set` waits for the previous one and sends the settings as they are when it runs, so the last write carries every change.
- **Keys.** ⌘W closes the active tab. The macOS menu in `main.rs` mirrors Tauri's default menu with Close Window moved to ⇧⌘W, so ⌘W reaches the webview. Global shortcuts live in `shell/commands.ts`.
- **History is a palette, and the right panel is a placeholder.** The sidebar's clock button opens `HistoryPalette` (cmdk), which pages `history_list` and puts `historyTail` on top. The right panel draws only an Assistant placeholder.
- **CSV export needs the desktop app.** `exportCsv` asks for a path with the native save dialog. In the dev-bridge browser that dialog throws, and the app shows a toast. Other export formats are disabled menu items marked "Soon", and Import shows a "coming soon" toast.
- **Catalogs are addressed by database (PR: address catalogs and consoles by database).** `Live` became `Instance` with a `DbSlot` per database; `ConnStatus::Connected.catalogVersion` and `AppEvent::CatalogChanged` are gone, and `InstanceState` in the connection snapshot is the only source of versions. `ConsoleConfig` and `ConsoleConfigView` carry a required `database`; the persisted `ConsoleConfigSnapshot.database` and `TabSnapshot::Table.database` are `Option<String>` so older workspaces load, and `tabFromSnapshot` resolves a missing one to the connection's configured database. A table tab whose connection no longer exists is dropped at restore. `StmtKind::invalidates()` maps a statement to `Nothing`, `Catalog`, or `DatabaseList`; `CREATE`, `DROP`, and `ALTER DATABASE` re-read `pg_database`, and `CONCURRENTLY` index DDL refreshes the catalog. `NotConnected` became `CatalogError { NotConnected | UnknownDatabase | NotShown | Failed }`. The status bar shows `connection · database` for the active tab, and ⌘P searches only the databases the tree shows, with `database.schema` beside an item when more than one is shown. The TopBar picker still lists connections and targets each one's configured database.
- **The output log is a toggle in the results pane.** #11 removed the `OutputLog` pane. The log came back as `OutputPanel`, which takes the results body behind an **Output** button in the results header, so it adds no chrome. The log is tab-wide: every run, commit, rollback, and `table_apply` on the tab, oldest first, with a hairline where the `runId` changes. Each statement logs a `Statement` line, its notices, and then a `Rows`, `Command`, or `Error` line. `table_apply` logs the SQL it built for each change and its affected-row tag. Every `OutputEntry` has a `runId`, and commit, rollback, and `table_apply` send the run id they take from the shared counter. `resultView` in `state/status.ts` picks the body: an Output pick made on the current run, then the row grid, then the log when the tab has entries, then the old tail. The tail is still needed because `output` is not in `BootSnapshot`, so after a restart the log is empty while the run state is restored. The pick `{ kind: "output", runId }` in `activeResult` lapses on the next run. The button turns amber only while the latest run in the log raised a WARNING. `output[tabId]` is never freed when a tab closes, which holds up to 5,000 entries per closed tab.

## Open questions and risks

Answered since the design:

- **Databases in the tree.** A connection is an instance. `InstanceState` lists every database of the server, and the tree draws the ones marked `shown` under the connection, each with its own catalog. Today that is the configured (home) database only; a visibility store is the next step. `Catalog.db` names the database.
- **System schemas.** `pg_catalog`, `information_schema`, `pg_toast`, and temp schemas are filtered out in `catalog.rs`. There is no toggle.
- **Timestamps.** The grid shows PG's text output verbatim, seconds included, and the export is verbatim too.
- **`COPY` over stdio.** `CopyStdio` covers `COPY ... TO STDOUT` as well as `FROM STDIN`, and `console_run` rejects both with `RunError::Unsupported`.

Still open:

- Are `max_rows = 200,000` and `max_result_bytes = 512 MiB` acceptable defaults? The settings screen does not expose `maxResultBytes`. Should a truncated result offer "Export full result", which re-runs the query streaming directly to CSV?
- Tabs are app-managed consoles that autosave. Do tabs also need open and save of `.sql` files on disk? Adding `origin: { kind: "file", path }` to `TabSnapshot` later doesn't disturb anything else.
- **Risk:** tauri-specta is still a release candidate (`=2.0.0-rc.25`, and docs.rs failed to build it). Pin exact versions of `tauri-specta`, `specta`, and `specta-typescript`. The fallback is `ts-rs` for types plus a handwritten `commands.ts` checked by the drift test.
- **Risk:** catalog size on very large databases. If the snapshot exceeds about 5 MB, switch columns to lazy per relation behind `catalog_get`. The `Relation.columns` shape stays the same.
- **Risk:** the dev-bridge runs in Chromium, not WKWebView. Rendering differences are covered only by `pnpm screenshot` until the `@wdio/tauri-service` follow-up lands.
- **Risk:** `prepare` fails for statements the extended protocol can't Describe. The classifier rejects `CopyStdio` up front with `RunError::Unsupported`. Other failures surface as a normal `QueryError`.
- **Risk:** table pages use `LIMIT n OFFSET m`. Postgres reads and discards every skipped row, so deep pages of a large table get slower.
- **Risk:** the pager's total is the catalog's `reltuples` estimate (`of ~241,183`) until the user presses Last, which fetches the exact count. A filtered table shows only a lower bound (`of 500+`) until then.
- **Risk:** `RightPanel::Schema` and `RightPanel::History` stay in the contract with no UI. `restore` maps them to `Assistant`.

## Next implementation step

The engine and the frontend are built and proven against Docker (`cargo test -p engine --features pg-tests`, `pnpm test`, `pnpm self-check`, `dev/bridge-smoke.sh`). Remaining work, in no set order:

- End-to-end tests in the real WKWebView with `@wdio/tauri-service`.
- The AI assistant. The right panel is a placeholder.
- Import. The button shows a "coming soon" toast.
- Export formats besides CSV. The menu lists them as disabled "Soon" items.
- Removing the dead `RightPanel::Schema` and `RightPanel::History` variants.

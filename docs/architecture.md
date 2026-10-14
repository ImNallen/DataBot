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
pnpm self-check                            # debug binary boots Engine inside Tauri, connects, prints JSON, exits
```

### Call site 1: frontend boot (src/main.tsx)

```ts
import { listen } from "@tauri-apps/api/event";
import { commands, type AppEvent } from "./ipc/bindings";
import { live } from "./state/live";

// Listen first, then snapshot. Every event carries a full entity snapshot with a `rev`,
// so an event that races the boot snapshot is harmless: the reducer keeps the higher rev.
await listen<AppEvent>("app-event", (e) => live.getState().apply(e.payload));
const boot = await commands.appBoot();           // live connections + consoles + workspace
live.getState().hydrate(boot);
workspace.getState().restore(boot.workspace);
```

### Call site 2: run the statement under the cursor (features/editor/runActions.ts)

```ts
export async function runAtCursor(tabId: TabId, view: EditorView) {
  const sel = view.state.selection.main;
  const target: RunTarget = sel.empty
    ? { kind: "cursor", offset: sel.head }
    : { kind: "selection", from: sel.from, to: sel.to };
  const res = await commands.consoleRun(tabId, { kind: "script", text: view.state.doc.toString(), target });
  if (res.status === "error") return toast(runErrorMessage(res.error)); // Busy | NoStatement | Connect(...)
  flashRanges(view, res.data.statements);   // UTF-16 doc ranges actually executed
  // Progress, results, errors arrive as AppEvent::ConsoleChanged / ConsoleOutput.
}
```

### Call site 3: the grid pulls a window of rows (features/results/ResultGrid.tsx)

```ts
const meta = useLive((s) => s.consoles[tabId]?.run.statements[i].result); // ResultMeta | undefined
const rows = useRowWindow(meta.ref, virtualizer.range);  // fetches 256-row pages via commands.resultPage
// header: meta.columns[c].name + meta.columns[c].type.display ("bigint", "timestamptz")
// align:  meta.columns[c].type.category === "numeric" ? "right" : "left"
// cell:   rows.get(r)?.[c] ?? NULL marker; null is SQL NULL, string is PG text output
await commands.resultExportCsv(meta.ref, path); // Rust writes from its own buffer
```

### Call site 4: engine integration test (crates/engine/tests/txn.rs)

```rust
#[tokio::test]
async fn manual_tab_isolated_until_commit() -> anyhow::Result<()> {
    let h = Harness::start().await?;                 // Engine on tmp dir + MemoryKeyStore + Docker PG (:5433)
    let a = h.sql_tab(Mode::Manual).await?;
    let b = h.sql_tab(Mode::AutoCommit).await?;
    h.run_ok(a, "insert into customers(name, region) values ('t', 'EU-West')").await?;
    assert_eq!(h.console(a).txn, TxnState::Active);
    assert_eq!(h.scalar(b, "select count(*) from customers where name='t'").await?, "0");
    h.engine.console_commit(a).await?;
    assert_eq!(h.scalar(b, "select count(*) from customers where name='t'").await?, "1");
    Ok(())
}
```

## Shape

### Load-bearing decisions

1. **Values travel as PostgreSQL's own text output. Types travel separately as column metadata.** Each statement is `prepare`d, which is Parse+Describe without execution. That yields column `Type`s with custom names resolved. The statement then runs through `simple_query_raw`, which streams text-format rows. A cell is `string | null`.
   - No per-type decoders exist anywhere.
   - Unknown and extension types render exactly as psql shows them.
   - Type-aware rendering keys off `TypeCategory` on the column, not off the value.
   - Session `TimeZone` is set to the OS IANA zone on session open, so timestamptz text is local time.
2. **Rust owns result rows. The webview pulls windows.** A `ResultSet` is an append-only text arena filled by the run task. The grid requests `resultPage(ref, start, len)`. CSV export writes straight from the arena. The webview never holds more than a few pages, and the row-cap policy lives in one place. Filter, sort, and value-viewer features later attach to the same arena without changing the grid.
3. **One dedicated session per tab, opened lazily, plus one metadata session per connection.** No pool. Session state (search_path, temp tables, GUCs, transactions) belongs to the tab, which is what an IDE user expects.
4. **During a run, the session moves into the run task.** `Console` holds `Option<Session>`. A run takes it and gives it back when finished. Commit, rollback, or a second run while it is gone returns `Busy`. Concurrent use of one session cannot be expressed.
5. **Snapshots over deltas.** The backend emits whole `ConsoleState` and `ConnectionState` values with a monotonically increasing `rev`. The frontend's live store is a pure projection: `apply(event)` keeps the higher rev. This is idempotent and tolerant of event order. Only the append-only output log uses deltas.
6. **One SQL lexer, in Rust.** `split_statements` and `classify` are pure functions. They handle dollar quotes, `E''` strings, nested block comments, and quoted identifiers. They drive statement picking, transaction-state tracking, DDL-triggered catalog refresh, and synthesized command tags. The frontend sends the whole document plus a cursor or selection. All offsets crossing IPC are UTF-16 code units (CodeMirror's unit), and the conversion happens once at the boundary.
7. **One full-catalog snapshot per connection, loaded in four queries.** It covers schemas, relations with `reltuples`, columns with PK flags, and functions. The tree, ⌘P fuzzy search, and CodeMirror completion are all derived from it. Successful DDL triggers a background refresh and a `CatalogChanged` event.
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
    Connected { server: ServerInfo, catalog_version: u64 },
    Failed { error: ConnectError },          // connect attempt failed
    Lost { reason: String },                 // metadata session died after being Connected
}
#[derive(Clone, Serialize, Type)]
pub struct ConnectionState { pub id: ConnectionId, pub rev: u64, pub status: ConnStatus }

#[derive(Clone, Serialize, Type)]
#[serde(tag = "kind")]
pub enum ConnectError {
    Network { message: String }, Tls { message: String },
    Auth { message: String }, MissingPassword, Server(QueryError), Keychain { message: String },
}

// ---- catalog (one snapshot per connection) -------------------------------------
#[derive(Clone, Serialize, Type)]
pub struct Catalog { pub connection_id: ConnectionId, pub version: u64, pub database: String, pub schemas: Vec<SchemaInfo> }
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
pub struct ConsoleConfig { pub connection_id: ConnectionId, pub schema: Option<String>, pub mode: TxnMode }

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
pub struct ConsoleConfigView { pub connection_id: ConnectionId, pub schema: Option<String>, pub mode: TxnMode }

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
    pub source: Option<ColumnSource>,  // table_oid + attnum: hook for future inline editing
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
#[derive(Clone, Serialize, Type)]
pub struct OutputEntry { pub at_ms: i64, pub run_id: Option<RunId>, pub body: OutputBody }
#[derive(Clone, Serialize, Type)]
#[serde(tag = "kind")]
pub enum OutputBody {
    Notice { severity: String, message: String, detail: Option<String> },
    Command { statement: u16, tag: String, elapsed_ms: u32 },
    Rows { statement: u16, rows: u64, elapsed_ms: u32, truncated: bool },
    Error { statement: Option<u16>, error: QueryError },
    Info { message: String },          // "BEGIN (implicit)", "Session reset: connection was lost"
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
    Table { id: TabId, connection_id: ConnectionId, schema: String, table: String, page: u32 },
}
#[derive(Clone, Serialize, Deserialize, Type)]
pub struct ConsoleConfigSnapshot { pub connection_id: Option<ConnectionId>, pub schema: Option<String>, pub mode: TxnMode }
#[derive(Clone, Serialize, Deserialize, Type)]
pub struct Layout { pub sidebar: bool, pub results: bool, pub right_panel: Option<RightPanel>, pub results_height: u16 }
#[derive(Clone, Serialize, Deserialize, Type)] pub enum RightPanel { Assistant, Schema, History }

#[derive(Clone, Serialize, Deserialize, Type)]
pub struct Settings { pub max_rows: u32 /* 200_000 */, pub max_result_bytes: u64 /* 512 MiB */, pub table_page_size: u32 /* 500 */, pub stop_on_error: bool }

#[derive(Serialize, Type)]
pub struct BootSnapshot {
    pub connections: Vec<ConnectionConfig>, pub live: Vec<ConnectionState>,
    pub consoles: Vec<ConsoleState>, pub workspace: Workspace, pub settings: Settings,
}

// ---- the one event (emitted as "app-event") -------------------------------------
#[derive(Clone, Serialize, Type)]
#[serde(tag = "kind")]
pub enum AppEvent {
    ConnectionChanged(ConnectionState),
    CatalogChanged { connection_id: ConnectionId, version: u64 },
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
| `connection_connect` | `ConnectionId` | `Result<ServerInfo, ConnectError>` | Idempotent. Opens the metadata session and loads the catalog. |
| `connection_disconnect` | `ConnectionId, force: bool` | `Result<(), DisconnectError>` | `OpenTransactions { tabs: Vec<(TabId, bool /*has_writes*/)> }` unless forced. |
| `catalog_get` | `ConnectionId` | `Result<Catalog, NotConnected>` | Whole snapshot, fetched on `CatalogChanged`. |
| `catalog_refresh` | `ConnectionId` | `Result<u64, NotConnected>` | Returns the new version. The event also fires. |
| `console_configure` | `TabId, ConsoleConfig` | `Result<ConsoleState, ConfigureError>` | Upsert. `TransactionOpen` if mode/connection change with a live txn. A schema change issues `SET search_path` (applied on next run if busy). |
| `console_run` | `TabId, RunRequest` | `Result<RunAccepted, RunError>` | Returns once statements are picked. Progress arrives as events. |
| `console_cancel` | `TabId` | `()` | Idempotent. Sets the stop flag and sends `CancelRequest`. |
| `console_commit` | `TabId` | `Result<(), TxnError>` | `Busy`, `NoTransaction`. Commit in `Aborted` reports `RolledBack`. |
| `console_rollback` | `TabId` | `Result<(), TxnError>` | |
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
    /// Engine builds quoted SQL ordered by the catalog's PK columns (no ORDER BY without a PK).
    TablePage { schema: String, table: String, page: u32 },
}
#[derive(Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RunTarget { Cursor { offset: DocOffset }, Selection { from: DocOffset, to: DocOffset }, All, }
#[derive(Serialize, Type)]
pub struct RunAccepted { pub run_id: RunId, pub statements: Vec<DocRange> }
#[derive(Serialize, Type)]
#[serde(tag = "kind")]
pub enum RunError { Busy, NoStatement, NotConfigured, Unsupported { what: String /* COPY FROM STDIN */ }, Connect(ConnectError) }
#[derive(Serialize, Type)] #[serde(tag = "kind")] pub enum TxnError { Busy, NoTransaction, RolledBack, Query(QueryError) }
#[derive(Serialize, Type)] #[serde(tag = "kind")] pub enum ResultError { Gone, OutOfRange }
#[derive(Serialize, Type)] pub struct ExportSummary { pub rows: u64, pub bytes: u64, pub truncated: bool }
```

Table data tabs need no extra command to read. A table tab sends `RunRequest::TablePage` with its `TableQuery` (`where`, per-column `filters`, `orderBy`) to `console_run` on its own console. The engine builds `SELECT * FROM "public"."orders" WHERE … ORDER BY <user order>, <pk cols> LIMIT 500 OFFSET 1000` with a pure, tested `browse_sql` function and then follows the same run path as a script. One execution path serves both tab kinds, and identifier quoting has one owner.

Writing uses one command, `table_apply(tab, TableChanges)`. It borrows the tab's session the way Commit and Rollback do, and runs deletes, then updates, then inserts. With no transaction open, auto-commit mode wraps them in `BEGIN … COMMIT`, and manual mode leaves them in a new open transaction. Inside an open transaction they run under a savepoint, so a failure leaves that transaction as it was. Rows to update or delete are found by their full primary key, and each statement must affect exactly one row. Otherwise everything rolls back, and the error names the change that failed.

### Engine (crates/engine/src/lib.rs, the deep module)

```rust
pub struct Engine { /* store, vault, settings, connections, consoles, events, next_run */ }

pub struct EngineConfig { pub data_dir: PathBuf, pub keys: Arc<dyn KeyStore> }

impl Engine {
    pub async fn open(cfg: EngineConfig) -> Result<Arc<Self>, StoreError>;   // opens SQLite, runs migrations
    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent>;                // Tauri shell + tests
    pub fn boot(&self) -> BootSnapshot;

    pub async fn save_connection(&self, d: ConnectionDraft) -> Result<ConnectionConfig, SaveError>;
    pub async fn delete_connection(&self, id: ConnectionId) -> Result<(), DisconnectError>;
    pub async fn test_connection(&self, d: ConnectionDraft) -> Result<ServerInfo, ConnectError>;
    pub async fn connect(&self, id: ConnectionId) -> Result<ServerInfo, ConnectError>;
    pub async fn disconnect(&self, id: ConnectionId, force: bool) -> Result<(), DisconnectError>;
    pub fn catalog(&self, id: ConnectionId) -> Result<Arc<Catalog>, NotConnected>;
    pub async fn refresh_catalog(&self, id: ConnectionId) -> Result<u64, NotConnected>;

    pub async fn console_configure(&self, tab: TabId, c: ConsoleConfig) -> Result<ConsoleState, ConfigureError>;
    pub async fn console_run(&self, tab: TabId, r: RunRequest) -> Result<RunAccepted, RunError>;
    pub async fn console_cancel(&self, tab: TabId);
    pub async fn console_commit(&self, tab: TabId) -> Result<(), TxnError>;
    pub async fn console_rollback(&self, tab: TabId) -> Result<(), TxnError>;
    pub async fn console_close(&self, tab: TabId, force: bool) -> Result<(), DisconnectError>;

    pub fn result_page(&self, r: ResultRef, start: u32, len: u32) -> Result<RowPage, ResultError>;
    pub fn result_cell(&self, r: ResultRef, row: u32, col: u16) -> Result<Option<String>, ResultError>;
    pub async fn export_csv(&self, r: ResultRef, path: PathBuf) -> Result<ExportSummary, ExportError>;

    pub fn history(&self, q: HistoryQuery) -> HistoryPage;
    pub fn clear_history(&self);
    pub fn save_workspace(&self, w: Workspace);
    pub fn set_settings(&self, s: Settings);
}
```

The surface is about 20 methods, matching the commands one to one. Behind it the engine hides:

- TLS mode mapping and keychain reads
- Session lifecycle, lazy reconnects, and `search_path` / `TimeZone` setup
- Statement splitting and picking
- Implicit `BEGIN`
- Transaction-state tracking
- Prepare/describe and text streaming
- The row cap with drain
- Throttled snapshot emission
- History recording
- DDL-triggered catalog refresh
- UTF-16 offset mapping

The frontend never sequences two calls to complete one operation.

### Internal structure

```rust
// console.rs
pub(crate) struct Console {
    tab: TabId,
    inner: Mutex<ConsoleInner>,          // tokio Mutex, held only for state edits, never across a query
}
struct ConsoleInner {
    config: ConsoleConfigView,
    session: SessionSlot,
    txn: TxnState,
    run: RunState,
    results: Vec<Arc<ResultSet>>,        // results of the current/last run only; dropped on re-run
    rev: u64,
}
enum SessionSlot {
    Empty,
    Idle(Session),
    InRun { run_id: RunId, cancel: CancelHandle },   // the Session is owned by the run task
    Lost { reason: String, txn_lost: bool },
}
struct CancelHandle { token: tokio_postgres::CancelToken, tls: MakeTlsConnector, stop: Arc<AtomicBool> }

// session.rs
pub(crate) struct Session {
    client: tokio_postgres::Client,
    backend_pid: i32,
    notices: mpsc::UnboundedReceiver<DbError>,   // fed by the Connection driver task (poll_message)
    closed: watch::Receiver<Option<String>>,     // Some(reason) once the driver task exits
}
impl Session {
    /// Connects, sets TimeZone, application_name='L1 Data', search_path; spawns the driver task.
    pub async fn open(p: &ConnectParams, schema: Option<&str>) -> Result<Session, ConnectError>;
}

// results.rs: single writer (run task), many readers (result_page); append-only.
pub(crate) struct ResultSet { pub meta_static: (ResultRef, Vec<ColumnMeta>), data: RwLock<Arena> }
struct Arena { text: String, cells: Vec<(u32, u32)> /* (start, len); len == u32::MAX = NULL */, ncols: u16, rows_seen: u64, truncated: Option<TruncateReason> }

// sql/split.rs, sql/classify.rs: pure
pub struct StmtSpan { pub start: usize, pub end: usize }        // UTF-8 byte offsets, trimmed
pub fn split_statements(sql: &str) -> Vec<StmtSpan>;
pub fn pick(spans: &[StmtSpan], sql: &str, target: ByteTarget) -> Vec<StmtSpan>;
pub enum StmtKind { Begin, Commit, Rollback, Savepoint, RollbackTo, Release, Ddl, Dml(DmlVerb), Query, CopyStdio, Other }
pub fn classify(stmt: &str) -> StmtKind;

// txn.rs: pure, exhaustively tested
pub enum StmtOutcome { Ok, Err }
pub fn txn_after(state: TxnState, kind: &StmtKind, outcome: StmtOutcome) -> TxnState;
pub fn needs_implicit_begin(mode: TxnMode, state: TxnState, kind: &StmtKind) -> bool;

// text.rs: pure boundary conversions
pub struct OffsetMap<'a> { /* sql text */ }
impl OffsetMap<'_> {
    pub fn to_utf16(&self, byte: usize) -> DocOffset;
    pub fn from_utf16(&self, off: DocOffset) -> usize;
    /// PG ErrorPosition::Original(n) is a 1-based character index within the statement.
    pub fn pg_position(&self, stmt: &StmtSpan, n: u32) -> DocOffset;
}
pub fn type_ref(t: &tokio_postgres::types::Type) -> PgTypeRef;       // int8 -> bigint, _int4 -> integer[], Kind -> category
pub fn synthesize_tag(kind: &StmtKind, rows: u64) -> String;          // "INSERT 0 3", "UPDATE 3", "CREATE TABLE"
```

### Run loop (console.rs, pseudocode)

```rust
async fn run_task(console: Arc<Console>, mut session: Session, run: RunPlan, eng: Arc<EngineShared>) {
    for (i, stmt) in run.statements.iter().enumerate() {
        if run.stop.load() { mark rest Cancelled/Skipped; break }
        let kind = classify(stmt.sql);
        // TODO: if needs_implicit_begin(mode, txn, kind) => session.client.batch_execute("BEGIN"), Info entry
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
        drain session.notices -> ConsoleOutput
        txn = txn_after(txn, &kind, outcome.ok_or_err());
        eng.history.record(...);                         // single writer: run tasks, via store mutex
        if outcome.failed() && settings.stop_on_error { mark rest Skipped; break }
        if kind == Ddl && ok && txn == Idle { eng.schedule_catalog_refresh(conn) }
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
- **Metadata session death.** Only `ConnectionState` becomes `Lost`. Consoles are independent.

`disconnect(force=false)` checks every console of that connection that is `Active` or `Aborted`. To compute `has_writes` it runs `SELECT pg_current_xact_id_if_assigned() IS NOT NULL` (PG13+, else `true`) on the idle session.

### Frontend (React 19, TypeScript, Vite)

- **Framework: React 19.** cmdk covers the ⌘P palette, Radix primitives cover menus and dialogs, and TanStack Virtual covers the grid. The AI panel later lands in React's ecosystem. Agents write React most reliably, which speeds the verify loop.
- **Editor: CodeMirror 6, used directly** (no wrapper library). One `EditorView` is mounted, and the `EditorState` is swapped per tab, so undo history survives tab switches. `sql({ dialect: PostgreSQL, schema, defaultSchema, upperCaseKeywords: true })` provides highlighting and schema completion. A lint source renders `QueryError.position` as a diagnostic.
- **Grid: a hand-built DOM grid on `@tanstack/react-virtual`.** Fixed 36 px rows. Rows are always virtualized. Columns are virtualized when there are more than 40. The header shows name and type in two lines, and a sticky row-number column is on the left. Numeric categories are right aligned with digit grouping, inserted textually so precision is never lost. NULL renders as a dim `NULL`. Cut cells show an ellipsis, and clicking one calls `result_cell`. Selection of a cell range is copied as TSV.
- **Styling: Tailwind v4** with CSS variables for the dark theme tokens from the mockup.

Stores (Zustand v5). Each has one owner, and derived data is never stored:

```ts
// state/live.ts: pure projection of backend events. No component writes here.
type LiveState = {
  connections: Record<ConnectionId, ConnectionState>;
  consoles: Record<TabId, ConsoleState>;
  output: Record<TabId, OutputEntry[]>;                // ring buffer, 5,000 per tab
  hydrate(b: BootSnapshot): void;
  apply(e: AppEvent): void;                            // keep-higher-rev; exhaustive switch on e.kind
};

// state/workspace.ts: UI-owned; persisted via workspace_save (debounced)
type Tab =
  | { kind: "sql"; id: TabId; title: string; console: ConsoleConfigSnapshot }
  | { kind: "table"; id: TabId; connectionId: ConnectionId; schema: string; table: string; page: number };
type WorkspaceState = {
  tabs: Record<TabId, Tab>; order: TabId[]; active: TabId | null; layout: Layout;
  configs: Record<ConnectionId, ConnectionConfig>;
  activeResult: Record<TabId, number>;                 // which statement's result is shown
};
// SQL text lives only in CodeMirror: editorStates: Map<TabId, EditorState> (module-level).
// workspaceSnapshot() reads doc text from there. No second copy of the text is kept.

// state/catalog.ts: per connection, rebuilt when catalog version changes (memoized)
type CatalogView = {
  catalog: Catalog;
  completion: SQLNamespace;                            // {schema: {table: [cols]}} for lang-sql
  searchItems: SearchItem[];                           // tables, views, functions, "table.column"
  relationsById: Map<number, { schema: string; rel: Relation }>;
};

// state/rowCache.ts: outside React, per ResultRef, LRU of 256-row pages (max 64 pages)
class RowCache { constructor(ref: ResultRef); get(row: number): (string | null)[] | undefined; ensure(range: { start: number; end: number }): Promise<void>; }
```

The UI derives its status values instead of storing them:

| Derived status | Source |
|---|---|
| Run button: Run or Cancel | `consoles[tab].run.kind` |
| Status bar text | `connections[id].status` + `consoles[tab].config` + `txn` |
| Commit/Rollback visibility | `config.mode === "Manual" && txn !== "Idle"` |
| "6 rows · 38 ms" | `ResultMeta` |
| Unsaved dot | Shown only while `txn !== "Idle"` in manual mode ("uncommitted work"). Consoles autosave text to the workspace, so a text-dirty dot would mean nothing. |

### Persistence

Everything lives under `app_data_dir()` (override with `L1_DATA_DATA_DIR` in debug builds), in one SQLite file `l1-data.sqlite3` (rusqlite, bundled) with `PRAGMA user_version` migrations:

- `connections(id TEXT PK, json TEXT)`. Configs only.
- `history(id INTEGER PK, at_ms, connection_id, connection_name, database, sql, elapsed_ms, outcome_json)`, indexed on `(connection_id, id)`. Search is `LIKE`; FTS5 can come later. Pruned to the newest 10,000 entries on insert.
- `kv(key TEXT PK, json TEXT)`. Holds `workspace` and `settings`.
- `secrets(connection_id TEXT PK, nonce BLOB, ciphertext BLOB)`. One sealed password per connection.

The OS credential store holds one item, a random 32-byte master key, with service `dev.l1data.app` and user `master-key`. macOS therefore asks for keychain access once, not once per connection. Each password is sealed with XChaCha20-Poly1305 under that key, with a random nonce and the connection id as associated data, and the result is stored in the `secrets` table. All passwords do not go into one keychain item because Windows Credential Manager caps an item at 2560 bytes. The first saved password creates the key. Reading a password never creates one. If the key is missing or a password fails to open (wiped keychain, copied data dir, memory store restart), the connection behaves as if it had no password, and the user enters it again at the `MissingPassword` prompt. `trait KeyStore { load, save }` has two implementations: `KeyringKeyStore` and `MemoryKeyStore`. The second exists for tests and e2e, selected by `L1_DATA_SECRET_STORE=memory` in debug builds only. SQLite access is a `std::sync::Mutex<rusqlite::Connection>`. Writes are single-row and sub-millisecond, so they run inline.

### Repo layout

```
Cargo.toml                    # workspace: crates/engine, crates/dev-bridge, src-tauri
package.json  vite.config.ts  tsconfig.json
crates/engine/
  src/lib.rs                  # Engine facade
  src/model.rs                # every IPC type (single source)
  src/connection.rs           # ConnectParams, TLS (postgres-native-tls), LiveConnection, metadata session
  src/session.rs              # Session: client + driver task + notices + death watch
  src/console.rs              # Console, SessionSlot, run task
  src/txn.rs                  # pure transaction state machine
  src/sql/{split,classify}.rs # pure lexer, picker, classifier
  src/text.rs                 # UTF-16 mapping, type_ref, synthesize_tag, browse_sql
  src/results.rs              # Arena, pages, CSV writer
  src/catalog.rs              # 4 catalog queries -> Catalog
  src/store.rs                # SQLite: migrations, connections, history, kv
  src/secrets.rs              # Vault + KeyStore (Keyring/Memory)
  tests/                      # pg-tests feature: Harness + scenario files
src-tauri/
  src/main.rs                 # builder, specta export, event forwarder task, plugins
  src/ipc.rs                  # #[tauri::command] one-liners
  tauri.conf.json  capabilities/default.json
src/                          # frontend
  ipc/bindings.ts             # GENERATED, checked in
  state/{live,workspace,catalog,rowCache}.ts
  shell/{AppLayout,TopBar,StatusBar}.tsx
  features/sidebar/{ConnectionTree,SearchPalette}.tsx
  features/connections/ConnectionDialog.tsx
  features/editor/{SqlEditor,editorStates,runActions,completion}.ts(x)
  features/results/{ResultsPane,ResultGrid,OutputLog,format}.ts(x)
  features/history/{HistoryPalette.tsx,historyList.ts}
crates/dev-bridge/             # bin (not shipped): axum on 127.0.0.1:7077, POST /invoke/:cmd + GET /events (SSE)
src/dev/bridgeShim.ts         # loaded only in vite dev outside Tauri: mockIPC -> fetch, SSE -> emit("app-event")
dev/{docker-compose.yml,seed.sql}   # shop + lab.type_zoo, already committed
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
2. **Engine against real Postgres** (`pnpm db:up && cargo test -p engine --features pg-tests`). `Harness` uses `MemoryKeyStore`, a temp data dir, and `L1_DATA_TEST_PG` (default `postgres://l1data:l1data@localhost:5433/shop`). Scenarios:
   - connect reports a 16.x server version
   - catalog of `shop` contains the mockup's tables with PKs and estimates after `ANALYZE`
   - every `lab.type_zoo` cell equals Postgres's own text output: numeric, timestamptz, interval, json/jsonb, int[], text[], bytea, uuid, inet, enum, point, range, NULL
   - mockup query returns 6 rows with `orders: bigint`
   - multi-statement run yields `UPDATE n` tags and a `RAISE NOTICE` Output entry
   - error position maps to the right UTF-16 offset
   - cancel `pg_sleep(30)` finishes `Cancelled` in under 2 s
   - manual isolation and commit (call site 4); error leads to `Aborted`, then rollback leads to `Idle`
   - `pg_terminate_backend` of a console pid gives `Lost { txn_lost }`
   - `generate_series(1, 300000)` truncates at `max_rows` with `rows_seen = 300000`
   - CSV export equals `COPY ... TO STDOUT CSV` output
   - history persists across `Engine::open` on the same dir
   - DDL triggers `CatalogChanged`
3. **Frontend units** (`pnpm test`, vitest):
   - `live.apply` rev ordering and exhaustiveness
   - numeric grouping on text (`-1234567.890` → `-1,234,567.890`)
   - catalog → `SQLNamespace` and search items
   - `RowCache` page math
4. **Contract drift**: a `src-tauri` test (`export_bindings_up_to_date`) renders bindings to a string and asserts equality with `src/ipc/bindings.ts`. A second test asserts the dev-bridge dispatch table covers exactly the registered command names.
5. **UI against the real engine** (`pnpm bridge`). `crates/dev-bridge` hosts the same `Engine` (MemoryKeyStore, temp `L1_DATA_DATA_DIR`) behind `POST /invoke/:cmd` and an SSE stream of `AppEvent`. In vite dev outside Tauri, `src/dev/bridgeShim.ts` installs `mockIPC` from `@tauri-apps/api/mocks` (with `shouldMockEvents`) that forwards every command to the bridge and re-emits SSE frames as `app-event`. The generated bindings run unchanged. An agent drives it with agent-browser or Playwright, selecting by `data-testid`:
   - create connection via the dialog, test it, save it, and see "Live" plus `customers 18.4k`-style estimates in the tree
   - ⌘P "ord it" opens `order_items`; the table tab shows 500 rows
   - new tab: type the mockup query, ⌘↵, see status "6 rows ·", headers `region text`, `orders bigint`, right-aligned numbers
   - run `select slow_echo(30)`, click Cancel, see Output show `canceling statement due to user request`
   - switch to Manual: insert, then a second tab's count is unchanged; Commit, and the count changes
   - reload the page: tabs, text, and history are restored
6. **Real shell.** `pnpm self-check` launches the debug binary with `L1_DATA_SELF_CHECK=1`: it boots `Engine` inside Tauri, connects to the dev DB, runs `SELECT 1` and loads the catalog, prints JSON, and exits 0. A macOS `screencapture` of `pnpm tauri dev` against the mockup covers WKWebView rendering. Driving the real webview with `@wdio/tauri-service` (embedded provider, verified to support macOS) is the planned follow-up.

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
- **Command parameter names** (the camelCase invoke keys) are `draft`, `id`, `force`, `tabId`, `config`, `request`, `resultRef`, `start`, `len`, `row`, `col`, `path`, `query`, `workspace`, and `settings`. `resultRef` replaces `ref` because `ref` is a Rust keyword.
- **`console_cancel` takes `AppHandle`, not `State`.** Tauri requires async commands that borrow `State` to return `Result`, and `console_cancel` returns `()`.
- **Pins.** tauri-specta `=2.0.0-rc.25` requires specta `=2.0.0-rc.25` and specta-typescript `=0.0.12`. Bindings use `dangerously_cast_bigints_to_number()`, so `u64` and `i64` (revs, run ids, row counts, epoch millis) export as `number`. All of them stay below 2^53.
- **Bindings regeneration.** Besides debug-build startup, `pnpm bindings` reruns `export_bindings_up_to_date` with `UPDATE_BINDINGS=1`, which rewrites the file without opening a window.
- **Dispatch coverage source.** The dev-bridge test parses the generated `bindings.ts`, not a hand-kept constant. The drift test already proves that file equals the Tauri registration. The test compares command names and camelCase argument names.
- **Dev-bridge protocol.** The route is `/invoke/{cmd}` (axum 0.8 path syntax). A command's own result is 200 `{status:"ok",data}` or 200 `{status:"error",error}`. An unknown command (404), bad argument (400), or engine panic (500) returns `{message}`, and the shim throws it as a real `Error`, so `typedError` rethrows instead of returning a typed error. The body is parsed as JSON whatever the content-type, so a bare `curl -d '{}'` works. `L1_DATA_DATA_DIR` overrides the bridge's temporary data directory.
- **Window creation.** The `main` window is declared in `tauri.conf.json` with `"create": false` and built in `setup`, so `L1_DATA_SELF_CHECK=1` runs without a window. The self-check prints `{"ok":false,...,"connect":{"status":"notImplemented"}}` and exits 1 until the engine phase adds the connect, `SELECT 1`, and catalog steps.
- **Window chrome.** On macOS, `main.rs` turns decorations back on with an overlay title bar and a hidden title. The native traffic lights sit over the sidebar header, and macOS handles resizing. On Windows and Linux, `tauri.conf.json` sets `decorations` to false, and the webview draws the resize edges and the minimize, maximize, and close buttons at the right of the toolbar. The toolbar and the sidebar header are drag regions on every platform. `hostedWindow()` returns `{ chrome: "native" }` on macOS, the custom controls elsewhere, and null in the dev-bridge browser, where no window controls show. The sidebar toggle leads whichever header touches the window's left edge. That is the sidebar header while the sidebar is open and the toolbar while it is hidden. `windowLeadingInset()` gives both headers the same left padding, so the toggle stays put. On macOS that padding clears the traffic lights. The "L1 Data" title follows the toggle on every platform.
- **Engine additions.** `Engine::data_dir()` lets the self-check report and the bridge log show the directory in use. `KeyringKeyStore` and `MemoryKeyStore` are implemented, not stubbed, and sealed passwords are keyed by `ConnectionId`.
- **Defaults the design left open.** `Settings::default()` sets `stop_on_error: true`. `Layout::default()` is sidebar and results shown, no right panel, and `results_height: 320`.
- **Fonts** come from `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono`, the variable-axis builds of the Fontsource packages.

Engine phase (every `todo!()` in `crates/engine` filled in, self-check wired). The contract did not change; `src/ipc/bindings.ts` is byte-identical.

- **`Deserialize` on `ConnectionConfig` and `HistoryOutcome`.** The store round-trips both as JSON. Rust-only derives, no wire effect.
- **`StmtKind` carries the command tag.** `Ddl(String)` and `Other(String)` hold the tag Postgres would print (`CREATE TABLE`, `SET`, `TRUNCATE TABLE`), because tokio-postgres reports only a row count. `NoTxnBlock(String)` (`VACUUM`, `CREATE DATABASE`, `... CONCURRENTLY`, `ALTER SYSTEM`) is excluded from the implicit `BEGIN`. `COPY ... TO STDOUT` is `CopyStdio` too, since the simple protocol cannot carry it either. `UNION`/`INTERSECT`/`EXCEPT` and a leading parenthesis classify as `Query`.
- **Console state split for sync readers.** `Console.results` (std mutex) and `Console.latest` (the last published `ConsoleState`) sit next to the tokio-mutexed `ConsoleInner`, so `result_page`, `result_cell`, and `boot()` never take the async lock. `SessionSlot::InRun` also records `backend_pid` and the stop flag, and `console_commit`/`console_rollback` move the session through the same slot, so a run during a commit reports `Busy`.
- **Connections keep their entry.** `ConnSlot::Disconnected` replaces removal on disconnect, so `rev` stays monotonic across reconnects. Only `connection_delete` removes the entry.
- **Schema changes apply at the next run.** The run task compares the session's `search_path` with the console config and issues `SET search_path TO "<schema>"` (the schema alone) before the first statement. One path serves both the busy and the idle case. `SET TimeZone` failures (an OS zone Postgres does not know) are ignored.
- **A FATAL answer is a dead session.** `pg_terminate_backend` delivers `FATAL 57P01` to the statement in flight before the driver task sees EOF, so the run task treats any FATAL as a loss and waits up to 500 ms for the driver's reason. `Session::closed_reason` also consults `Client::is_closed`.
- **Cancel between statements.** The next pending statement is marked `Cancelled`, the rest `Skipped`, outcome `Cancelled`. A statement that fails with `57014` while the stop flag is set is `Cancelled`; the same code without the flag (a `statement_timeout`) is `Failed`.
- **Catalog refresh after DDL in a transaction** waits for the commit (`ddl_pending` on the console), whether the commit is a `COMMIT` statement or `console_commit`.
- **`has_writes`** is probed by taking the idle session out of the slot like a run does, so the console lock is never held across the query; an aborted transaction or a busy session reports `true`.
- **A run task owns the tab only while the slot says so.** Every write a task makes to console state goes through `Console::edit(run_id, ..)`, which applies and publishes the edit only while `SessionSlot::InRun { run_id }` matches. Disconnect and close reassign the slot and finish the run themselves (statement in flight `Cancelled`, the rest `Skipped`, outcome `Cancelled`, `txn` Idle), send a `CancelRequest`, and the task gets `Orphaned` at its next write, stops, and drops its session.
- **CSV** uses CRLF records with a header row, quotes fields containing `"`, `,`, CR, or LF, writes NULL as an empty field and the empty string as `""`, which is `COPY ... CSV HEADER` modulo line endings. The pg test compares after normalizing CRLF.
- **Values are the output function's text**, so booleans are `t`/`f` as in psql. `bool::text` would say `true`; the type-zoo test's oracle is the simple protocol on an independent session, not `::text` casts.
- **`ServerInfo.version`** is the first token of `server_version` (`16.15` from `16.15 (Debian ...)`); the dev image is 16.15, not 16.4, so tests assert the `16.` prefix.
- **`engine::draft_from_url`** turns a `postgres://` URL into a `ConnectionDraft` for the self-check and the test harness.
- **Self-check report** is `{ ok, dataDir, report }` where `report` holds `server`, `select1` (rows and elapsed), and per-schema relation and function counts, or `{ step, error }` on failure with the typed error as JSON.
- **`dev/bridge-smoke.sh`** drives the dev-bridge with curl (save, connect, catalog, configure, run the mockup query, page) and asserts the SSE stream delivered the `Finished` snapshot with six rows.
- **Dev-bridge panic test** replaced: no command panics any more, so the test now checks that a typed error (`catalog_get` on an unknown id) comes back as a command error, not a bridge error.

## Open questions and risks

- Should the tree list every database on the server under a connection (the mockup shows a `shop` node), or only the configured database in v1? This design shows only the configured database and keeps the database name in `Catalog`.
- Are `max_rows = 200,000` and `max_result_bytes = 512 MiB` acceptable defaults? Should a truncated result offer "Export full result", which re-runs the query streaming directly to CSV?
- System schemas (`pg_catalog`, `information_schema`) are hidden in v1. Should they be shown behind a toggle?
- Mockup timestamps drop seconds (`2026-10-13 10:14`). Should the grid trim PG's full text output, or show it verbatim? This design shows it verbatim, and the export is always verbatim.
- Tabs are app-managed consoles that autosave. Do v1 tabs also need open and save of `.sql` files on disk? Adding `origin: { kind: "file", path }` to `TabSnapshot` later doesn't disturb anything else.
- **Risk:** tauri-specta is still a release candidate (`=2.0.0-rc.25`, and docs.rs failed to build it). Pin exact versions of `tauri-specta`, `specta`, and `specta-typescript`. The fallback is `ts-rs` for types plus a handwritten `commands.ts` checked by the drift test.
- **Risk:** catalog size on very large databases. If the snapshot exceeds about 5 MB, switch columns to lazy per relation behind `catalog_get`. The `Relation.columns` shape stays the same.
- **Risk:** the dev-bridge runs in Chromium, not WKWebView. Rendering differences are covered only by the shell screenshot until the `@wdio/tauri-service` follow-up lands.
- **Risk:** `prepare` fails for statements the extended protocol can't Describe (`COPY ... FROM STDIN`). The classifier rejects `CopyStdio` up front with `RunError::Unsupported`. Other failures surface as a normal `QueryError`.

## Next implementation step

The engine is complete and proven against Docker (`cargo test -p engine --features pg-tests`, `pnpm self-check`, `dev/bridge-smoke.sh`). Next is the frontend against the dev-bridge: the live store projection, the editor run actions, and the windowed grid, verified with the browser flow in verification section 5.

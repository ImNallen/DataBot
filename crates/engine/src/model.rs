use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct ConnectionId(pub Uuid);

/// Minted by the frontend (`crypto.randomUUID()`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct TabId(pub Uuid);

/// Engine-wide monotonic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Type)]
pub struct RunId(pub u64);

/// UTF-16 code-unit offset into the editor document as sent in `RunRequest::Script.text`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct DocOffset(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocRange {
    pub from: DocOffset,
    pub to: DocOffset,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum SslMode {
    Disable,
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: ConnectionId,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub ssl_mode: SslMode,
    pub ca_cert_path: Option<String>,
    pub has_password: bool,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum PasswordInput {
    Keep,
    Set(String),
    Clear,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionDraft {
    /// `None` creates a new connection.
    pub id: Option<ConnectionId>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub ssl_mode: SslMode,
    pub ca_cert_path: Option<String>,
    pub password: PasswordInput,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    /// `"16.4"`
    pub version: String,
    pub version_num: u32,
    pub encoding: String,
}

/// One database on one saved connection. Postgres catalogs and OIDs are per database, so every
/// catalog lookup, refresh, and count takes one of these. `database` is `pg_database.datname`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRef {
    pub connection_id: ConnectionId,
    pub database: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum ConnStatus {
    Disconnected,
    Connecting,
    /// The home session is open and `pg_database` was read. Catalogs load after this, each with
    /// its own `CatalogStatus`, so one unreachable database never fails the instance.
    Connected { server: ServerInfo, instance: InstanceState },
    Failed { error: ConnectError },
    /// The home database's metadata session died after being `Connected`.
    Lost { reason: String },
}

/// Every database of the instance, with the state of its catalog. The connection snapshot is the
/// single source of catalog versions.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InstanceState {
    /// `ConnectionConfig.database` as the server spells it.
    pub home: String,
    /// The database picker lists system databases only while this is on.
    pub show_system_databases: bool,
    /// Every row of `pg_database`, sorted by name.
    pub databases: Vec<DatabaseState>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseState {
    pub name: String,
    /// `datistemplate OR NOT datallowconn`. `postgres` is an ordinary database.
    pub system: bool,
    pub access: DbAccess,
    /// Whether the tree shows this database, resolved from the stored view. Never true without
    /// `DbAccess::Ok`.
    pub shown: bool,
    /// The schema picker lists system schemas only while this is on.
    pub show_system_schemas: bool,
    /// The schemas the tree shows under this database, in name order. Empty until the catalog
    /// serves a version.
    pub shown_schemas: Vec<String>,
    /// Non-system schema count for the database picker: from the catalog when one is served,
    /// else from `connection_probe_databases`.
    pub schema_count: SchemaCount,
    pub catalog: CatalogStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum SchemaCount {
    Unknown,
    Probing,
    Known { count: u32 },
    /// The probe session failed; `message` is the server's or the transport's text.
    Unavailable { message: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum DbAccess {
    Ok,
    /// `datallowconn` is false.
    NoConnections,
    /// `has_database_privilege(datname, 'CONNECT')` is false.
    NoPrivilege,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum CatalogStatus {
    /// No metadata session is wanted for this database.
    Idle,
    /// The first load is in flight. A reload keeps `Ready` with the old version.
    Loading,
    /// `version` comes from one engine-wide counter, so it rises across every database and every
    /// reconnect. The UI fetches `catalog_get` when it is newer than what it holds.
    Ready { version: u64 },
    /// The last load failed. `version` is the last good catalog's, which `catalog_get` still
    /// serves, so the UI keeps it until a reload succeeds.
    Failed { message: String, version: Option<u64> },
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionState {
    pub id: ConnectionId,
    pub rev: u64,
    pub status: ConnStatus,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum ConnectError {
    Network { message: String },
    Tls { message: String },
    Auth { message: String },
    MissingPassword,
    Server(QueryError),
    Keychain { message: String },
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub db: DatabaseRef,
    pub version: u64,
    /// The first existing non-system entry of `current_schemas(false)` on this database's
    /// metadata session, else `public` when it exists, else the first non-system schema by name.
    /// `None` only when the database has no non-system schema. "Default only" in the schema
    /// picker means this.
    pub default_schema: Option<String>,
    /// Every schema except `pg_toast` and temp schemas, in name order. A system schema carries
    /// its relations only while the tree shows it, and never its functions.
    pub schemas: Vec<SchemaInfo>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub name: String,
    /// `information_schema` or a `pg_` prefix, which Postgres reserves for its own schemas.
    pub system: bool,
    /// Tables, partitioned tables, and foreign tables, which the tree lists as tables. Counted by
    /// the schema query itself, so it is right for a system schema whose `relations` are not loaded.
    pub table_count: u32,
    pub relations: Vec<Relation>,
    pub functions: Vec<FunctionInfo>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum RelKind {
    Table,
    PartitionedTable,
    View,
    MaterializedView,
    ForeignTable,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Relation {
    pub oid: u32,
    pub name: String,
    pub kind: RelKind,
    /// `None` when `reltuples = -1` (never analyzed).
    pub row_estimate: Option<i64>,
    /// In `attnum` order.
    pub columns: Vec<ColumnInfo>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub attnum: i16,
    pub name: String,
    pub type_display: String,
    pub category: TypeCategory,
    pub not_null: bool,
    pub pk: bool,
    /// Part of any foreign key.
    pub fk: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FunctionInfo {
    pub oid: u32,
    pub name: String,
    pub args: String,
    pub returns: String,
    pub kind: FnKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum FnKind {
    Function,
    Procedure,
    Aggregate,
    Window,
}

/// What a table row shows past its columns, read by `relation_detail` when the row first opens.
/// It is not in `Catalog`, so a DDL refresh never scans constraints, indexes, and triggers.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RelationDetail {
    pub db: DatabaseRef,
    pub oid: u32,
    /// The catalog version the detail is at least as new as.
    pub catalog_version: u64,
    /// In `attnum` order.
    pub defaults: Vec<ColumnDefault>,
    /// Primary, then foreign, unique, and check, each by name.
    pub keys: Vec<KeyInfo>,
    /// Primary, then unique, then the rest, each by name.
    pub indexes: Vec<IndexInfo>,
    /// By name.
    pub triggers: Vec<TriggerInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDefault {
    pub column: String,
    pub value: DefaultValue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum DefaultValue {
    /// `pg_get_expr` of the default, with the cast dropped from a lone literal: `'pending'`, `now()`.
    Expr { sql: String },
    /// `GENERATED ALWAYS` (`always`) or `BY DEFAULT AS IDENTITY`.
    Identity { always: bool },
    /// `GENERATED ALWAYS AS (sql) STORED`, or `VIRTUAL` on PG 18.
    Generated { sql: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub name: String,
    /// In key order.
    pub columns: Vec<String>,
    pub kind: KeyKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum KeyKind {
    Primary,
    Unique,
    Foreign { ref_schema: String, ref_table: String, ref_columns: Vec<String>, on_delete: FkAction, on_update: FkAction },
    /// `definition` is `pg_get_constraintdef`: `CHECK ((qty > 0))`.
    Check { definition: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum FkAction {
    NoAction,
    Restrict,
    Cascade,
    SetNull,
    SetDefault,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    /// `pg_am.amname`: btree, hash, gin, gist, brin.
    pub method: String,
    pub unique: bool,
    pub primary: bool,
    /// False while `CREATE INDEX CONCURRENTLY` builds it or after that failed.
    pub valid: bool,
    /// The key list cut from `pg_get_indexdef`: `(created_at DESC)`, `(a) INCLUDE (b)`.
    pub keys: String,
    /// The predicate of a partial index, without redundant parentheses: `status <> 'paid'::text`.
    pub predicate: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TriggerInfo {
    pub name: String,
    pub timing: TriggerTiming,
    /// In INSERT, UPDATE, DELETE, TRUNCATE order.
    pub events: Vec<TriggerEvent>,
    pub per_row: bool,
    pub enabled: bool,
    /// Schema-qualified only when the function is not on the search path: `set_updated_at`.
    pub function: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum TriggerTiming {
    Before,
    After,
    InsteadOf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum TriggerEvent {
    Insert,
    Update,
    Delete,
    Truncate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum TxnMode {
    AutoCommit,
    Manual,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleConfig {
    pub connection_id: ConnectionId,
    /// A change resets the session like a connection change does.
    pub database: String,
    pub schema: Option<String>,
    pub mode: TxnMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum TxnState {
    Idle,
    Active,
    /// Only `ROLLBACK [TO SAVEPOINT]` is accepted.
    Aborted,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum SessionState {
    None,
    Open { backend_pid: i32 },
    Lost { reason: String, txn_lost: bool },
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleState {
    pub tab_id: TabId,
    pub rev: u64,
    pub config: ConsoleConfigView,
    pub session: SessionState,
    pub txn: TxnState,
    pub run: RunState,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleConfigView {
    pub connection_id: ConnectionId,
    pub database: String,
    pub schema: Option<String>,
    pub mode: TxnMode,
}

impl ConsoleConfigView {
    pub fn db(&self) -> DatabaseRef {
        DatabaseRef { connection_id: self.connection_id, database: self.database.clone() }
    }
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum RunState {
    Idle,
    Running {
        run_id: RunId,
        started_at_ms: i64,
        statements: Vec<StatementRun>,
    },
    Finished {
        run_id: RunId,
        elapsed_ms: u32,
        statements: Vec<StatementRun>,
        outcome: RunOutcome,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum RunOutcome {
    Ok,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StatementRun {
    pub index: u16,
    pub range: DocRange,
    pub status: StmtStatus,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum StmtStatus {
    Pending,
    Preparing,
    Rows { result: ResultMeta, done: bool },
    /// `tag` reads like `"UPDATE 3"`.
    Command { tag: String, elapsed_ms: u32 },
    Failed { error: QueryError },
    Cancelled,
    /// An earlier statement failed or was cancelled.
    Skipped,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RunRequest {
    Script { text: String, target: RunTarget },
    TablePage {
        schema: String,
        table: String,
        page: u32,
        #[serde(default)]
        query: TableQuery,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TableQuery {
    /// SQL after `ORDER BY`, e.g. `"created_at" DESC`; empty means primary key order.
    pub order_by: String,
    pub filters: Vec<ColumnFilter>,
    /// A boolean SQL expression ANDed with `filters`; empty means none.
    pub r#where: String,
}

// Hand-written so saved tabs missing a field still load. `#[serde(default)]` would do it too, but specta
// would then mark every TableQuery field optional in the TS bindings.
impl<'de> Deserialize<'de> for TableQuery {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Default, Deserialize)]
        #[serde(default, rename_all = "camelCase")]
        struct Stored {
            order_by: String,
            filters: Vec<ColumnFilter>,
            r#where: String,
        }
        let Stored { order_by, filters, r#where } = Stored::deserialize(d)?;
        Ok(TableQuery { order_by, filters, r#where })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ColumnFilter {
    pub column: String,
    pub op: FilterOp,
    /// Compared as a Postgres literal; ignored by `IsNull` and `NotNull`.
    pub value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum FilterOp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Contains,
    StartsWith,
    IsNull,
    NotNull,
}

#[derive(Debug, Clone, Copy, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RunTarget {
    Cursor { offset: DocOffset },
    Selection { from: DocOffset, to: DocOffset },
    All,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunAccepted {
    pub run_id: RunId,
    pub statements: Vec<DocRange>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResultRef {
    pub tab_id: TabId,
    pub run_id: RunId,
    pub index: u16,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResultMeta {
    pub r#ref: ResultRef,
    /// The database the rows came from. Column sources are its OIDs, so PK lookups key on this,
    /// not on the tab's current target, which a retarget can change under an old result.
    pub db: DatabaseRef,
    pub columns: Vec<ColumnMeta>,
    /// Rows stored and pageable.
    pub row_count: u32,
    /// Rows the server sent; greater than `row_count` when truncated.
    pub rows_seen: u64,
    pub truncated: Option<TruncateReason>,
    pub elapsed_ms: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum TruncateReason {
    RowLimit,
    ByteLimit,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub r#type: PgTypeRef,
    pub source: Option<ColumnSource>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PgTypeRef {
    pub oid: u32,
    /// `"bigint"`, `"integer[]"`, `"order_status"`.
    pub display: String,
    pub category: TypeCategory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum TypeCategory {
    /// int2, int4, int8, oid.
    Integer,
    /// numeric, real, double precision, money.
    Numeric,
    Text,
    Bool,
    Temporal,
    Json,
    Binary,
    Uuid,
    Network,
    Array,
    Enum,
    Composite,
    Range,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSource {
    pub table_oid: u32,
    pub attnum: i16,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RowPage {
    pub start: u32,
    pub rows: Vec<Vec<Option<String>>>,
    pub cut: Vec<(u32, u16)>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QueryError {
    pub severity: String,
    pub sqlstate: Option<String>,
    pub message: String,
    pub detail: Option<String>,
    pub hint: Option<String>,
    pub context: Option<String>,
    pub position: Option<DocOffset>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub rows: u64,
    pub bytes: u64,
    pub truncated: bool,
}

/// One line of a tab's output log: timestamped history of what the session ran and what the
/// server said. Statement outcomes also live in `ConsoleState.run`; that snapshot is the current
/// status, this log is the history. `run_id` is the run, commit, rollback, or apply that held the
/// session; run ids share one counter, so a later entry never carries a lower id.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OutputEntry {
    pub at_ms: i64,
    pub run_id: RunId,
    pub body: OutputBody,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum OutputBody {
    /// Logged when the statement starts, before its notices and its result line.
    Statement {
        statement: u16,
        text: String,
    },
    Rows {
        statement: u16,
        rows: u64,
        elapsed_ms: u32,
        truncated: bool,
    },
    Command {
        statement: u16,
        tag: String,
        elapsed_ms: u32,
    },
    Notice {
        severity: String,
        message: String,
        detail: Option<String>,
    },
    /// `statement` is `None` for a failure no statement owns, such as `SET search_path`.
    Error {
        statement: Option<u16>,
        error: QueryError,
    },
    Info {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub at_ms: i64,
    pub connection_id: ConnectionId,
    pub connection_name: String,
    pub database: String,
    pub sql: String,
    pub elapsed_ms: u32,
    pub outcome: HistoryOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum HistoryOutcome {
    Rows { rows: u64 },
    Command { tag: String },
    Error { message: String },
    Cancelled,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    pub text: Option<String>,
    pub connection_id: Option<ConnectionId>,
    pub before_id: Option<i64>,
    pub limit: u16,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub entries: Vec<HistoryEntry>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum HistoryFilter {
    All,
    Failed,
    Writes,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBrowseQuery {
    pub text: Option<String>,
    pub filter: HistoryFilter,
    pub before_id: Option<i64>,
    pub limit: u16,
    pub revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCounts {
    pub all: u32,
    pub failed: u32,
    pub writes: u32,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRun {
    pub id: i64,
    pub at_ms: i64,
    pub connection_name: String,
    pub elapsed_ms: u32,
    pub outcome: HistoryOutcome,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryGroupSummary {
    pub id: i64,
    pub latest_id: i64,
    pub latest_at_ms: i64,
    pub connection_id: ConnectionId,
    pub database: String,
    pub title: String,
    pub excerpt: String,
    pub run_count: u32,
    pub failed_count: u32,
    pub is_write: bool,
    pub representative: HistoryRun,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBrowsePage {
    pub groups: Vec<HistoryGroupSummary>,
    pub counts: HistoryCounts,
    pub has_more: bool,
    pub revision: u64,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryGroupQuery {
    pub id: i64,
    pub before_id: Option<i64>,
    pub limit: u16,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryGroupPage {
    pub sql: String,
    pub runs: Vec<HistoryRun>,
    pub has_more: bool,
    pub max_elapsed_ms: u32,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum HistoryError {
    Stale,
    Unavailable { message: String },
}

/// Owned by the frontend, stored verbatim by the engine (single writer: the UI).
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub tabs: Vec<TabSnapshot>,
    pub active: Option<TabId>,
    pub layout: Layout,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TabSnapshot {
    pub id: TabId,
    pub title: String,
    /// `None` only in workspaces written before table tabs saved their text; the frontend seeds the browse query.
    pub text: Option<String>,
    pub console: ConsoleConfigSnapshot,
    pub table: Option<TableSnapshot>,
}

/// The table a tab opened from the sidebar browses, in the tab's console database.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TableSnapshot {
    pub schema: String,
    pub table: String,
    pub page: u32,
    pub query: TableQuery,
}

// Hand-written so workspaces saved while tabs were a `Sql` or `Table` enum still load.
impl<'de> Deserialize<'de> for TabSnapshot {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(tag = "kind", rename_all_fields = "camelCase")]
        enum Legacy {
            Sql {
                id: TabId,
                title: String,
                text: String,
                console: ConsoleConfigSnapshot,
            },
            Table {
                id: TabId,
                connection_id: ConnectionId,
                database: Option<String>,
                schema: String,
                table: String,
                page: u32,
                #[serde(default)]
                query: TableQuery,
            },
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Current {
            id: TabId,
            title: String,
            text: Option<String>,
            console: ConsoleConfigSnapshot,
            table: Option<TableSnapshot>,
        }
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Saved {
            Legacy(Legacy),
            Current(Current),
        }
        Ok(match Saved::deserialize(d)? {
            Saved::Current(Current { id, title, text, console, table }) => Self { id, title, text, console, table },
            Saved::Legacy(Legacy::Sql { id, title, text, console }) => Self { id, title, text: Some(text), console, table: None },
            Saved::Legacy(Legacy::Table { id, connection_id, database, schema, table, page, query }) => Self {
                id,
                title: table.clone(),
                text: None,
                console: ConsoleConfigSnapshot { connection_id: Some(connection_id), database, schema: None, mode: TxnMode::AutoCommit },
                table: Some(TableSnapshot { schema, table, page, query }),
            },
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleConfigSnapshot {
    pub connection_id: Option<ConnectionId>,
    /// `None` only in workspaces written before tabs carried a database; the frontend resolves it to the
    /// connection's configured database, the only one such a tab could have used.
    pub database: Option<String>,
    pub schema: Option<String>,
    pub mode: TxnMode,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub sidebar: bool,
    pub results: bool,
    pub right_panel: Option<RightPanel>,
    pub results_height: u16,
    pub sidebar_width: u16,
    pub right_panel_width: u16,
    /// The chat the assistant panel shows, reopened after a restart.
    pub assistant_chat: Option<ChatId>,
}

impl Default for Layout {
    fn default() -> Self {
        Self {
            sidebar: true,
            results: true,
            right_panel: None,
            results_height: 320,
            sidebar_width: 256,
            right_panel_width: 341,
            assistant_chat: None,
        }
    }
}

// Hand-written so workspaces saved before the panel widths or the assistant chat existed still load.
// `#[serde(default)]` would do it too, but specta would then mark every Layout field optional in the TS bindings.
impl<'de> Deserialize<'de> for Layout {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Saved {
            sidebar: bool,
            results: bool,
            right_panel: Option<RightPanel>,
            results_height: u16,
            sidebar_width: Option<u16>,
            right_panel_width: Option<u16>,
            assistant_chat: Option<ChatId>,
        }
        let s = Saved::deserialize(d)?;
        let default = Self::default();
        Ok(Self {
            sidebar: s.sidebar,
            results: s.results,
            right_panel: s.right_panel,
            results_height: s.results_height,
            sidebar_width: s.sidebar_width.unwrap_or(default.sidebar_width),
            right_panel_width: s.right_panel_width.unwrap_or(default.right_panel_width),
            assistant_chat: s.assistant_chat,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum RightPanel {
    Assistant,
    Schema,
    History,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum ColorScheme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    Light,
    Dark,
}

/// A user theme: one card in the picker, holding every variant it was created or imported with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CustomTheme {
    pub id: String,
    pub name: String,
    pub variants: Vec<CustomThemeVariant>,
}

/// `colors` maps the frontend's token names to CSS colours; the engine only stores it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CustomThemeVariant {
    pub id: String,
    pub name: String,
    pub appearance: Appearance,
    pub colors: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum Density {
    Compact,
    #[default]
    Standard,
    Spacious,
}

/// `family` is a name the frontend's font registry resolves to a CSS stack; unknown names pass through.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FontSetting {
    pub family: String,
    pub size: u16,
}

impl FontSetting {
    fn interface_default() -> Self {
        Self { family: "Inter".into(), size: 13 }
    }

    fn code_default() -> Self {
        Self { family: "JetBrains Mono".into(), size: 13 }
    }
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub max_rows: u32,
    pub max_result_bytes: u64,
    pub table_page_size: u32,
    pub stop_on_error: bool,
    pub color_scheme: ColorScheme,
    /// Theme id painted while the scheme resolves to light.
    pub light_theme: String,
    /// Theme id painted while the scheme resolves to dark.
    pub dark_theme: String,
    pub custom_themes: Vec<CustomTheme>,
    pub interface_font: FontSetting,
    /// Used by the SQL editor and the result grid.
    pub code_font: FontSetting,
    pub density: Density,
    /// 0 turns panel animation off.
    pub panel_motion_ms: u16,
    /// Shade each colored connection in the sidebar tree instead of drawing its dot.
    pub tint_connections: bool,
    /// One per `ProviderKind::ALL`, in that order.
    pub providers: Vec<ProviderConfig>,
    /// Seconds between background provider status checks; 0 turns them off.
    pub provider_health_check_secs: u32,
}

const DEFAULT_PANEL_MOTION_MS: u16 = 150;
const DEFAULT_PROVIDER_HEALTH_CHECK_SECS: u32 = 300;

const DEFAULT_LIGHT_THEME: &str = "l1-light";
const DEFAULT_DARK_THEME: &str = "l1-dark";

/// The first saved config of each kind, else its default. A kind added by a later build appears on its own.
fn provider_configs(saved: Vec<ProviderConfig>) -> Vec<ProviderConfig> {
    ProviderKind::ALL
        .iter()
        .map(|&kind| saved.iter().find(|c| c.provider == kind).cloned().unwrap_or_else(|| default_config(kind)))
        .collect()
}

// Hand-written for the same reason as `TableQuery`: settings saved by older builds still load
// (`theme` became `colorScheme`; the theme, font, density, motion, tint, and provider fields came later), and the TS binding keeps every field required.
impl<'de> Deserialize<'de> for Settings {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Stored {
            max_rows: u32,
            max_result_bytes: u64,
            table_page_size: u32,
            stop_on_error: bool,
            #[serde(default, alias = "theme")]
            color_scheme: ColorScheme,
            light_theme: Option<String>,
            dark_theme: Option<String>,
            #[serde(default)]
            custom_themes: Vec<CustomTheme>,
            interface_font: Option<FontSetting>,
            code_font: Option<FontSetting>,
            #[serde(default)]
            density: Density,
            panel_motion_ms: Option<u16>,
            #[serde(default)]
            tint_connections: bool,
            providers: Option<Vec<ProviderConfig>>,
            provider_health_check_secs: Option<u32>,
        }
        let s = Stored::deserialize(d)?;
        Ok(Settings {
            max_rows: s.max_rows,
            max_result_bytes: s.max_result_bytes,
            table_page_size: s.table_page_size,
            stop_on_error: s.stop_on_error,
            color_scheme: s.color_scheme,
            light_theme: s.light_theme.unwrap_or_else(|| DEFAULT_LIGHT_THEME.into()),
            dark_theme: s.dark_theme.unwrap_or_else(|| DEFAULT_DARK_THEME.into()),
            custom_themes: s.custom_themes,
            interface_font: s.interface_font.unwrap_or_else(FontSetting::interface_default),
            code_font: s.code_font.unwrap_or_else(FontSetting::code_default),
            density: s.density,
            panel_motion_ms: s.panel_motion_ms.unwrap_or(DEFAULT_PANEL_MOTION_MS),
            tint_connections: s.tint_connections,
            providers: provider_configs(s.providers.unwrap_or_default()),
            provider_health_check_secs: s.provider_health_check_secs.unwrap_or(DEFAULT_PROVIDER_HEALTH_CHECK_SECS),
        })
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            max_rows: 200_000,
            max_result_bytes: 512 * 1024 * 1024,
            table_page_size: 500,
            stop_on_error: true,
            color_scheme: ColorScheme::System,
            light_theme: DEFAULT_LIGHT_THEME.into(),
            dark_theme: DEFAULT_DARK_THEME.into(),
            custom_themes: Vec::new(),
            interface_font: FontSetting::interface_default(),
            code_font: FontSetting::code_default(),
            density: Density::Standard,
            panel_motion_ms: DEFAULT_PANEL_MOTION_MS,
            tint_connections: false,
            providers: provider_configs(Vec::new()),
            provider_health_check_secs: DEFAULT_PROVIDER_HEALTH_CHECK_SECS,
        }
    }
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BootSnapshot {
    pub connections: Vec<ConnectionConfig>,
    pub live: Vec<ConnectionState>,
    pub consoles: Vec<ConsoleState>,
    pub workspace: Workspace,
    pub settings: Settings,
    pub providers: Vec<ProviderState>,
    /// Stored chats, newest first, at most 200.
    pub chats: Vec<ChatState>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum AppEvent {
    ConnectionChanged(ConnectionState),
    /// Throttled to at most 10/s per console while streaming.
    ConsoleChanged(ConsoleState),
    ConsoleOutput {
        tab_id: TabId,
        entries: Vec<OutputEntry>,
    },
    HistoryAppended(HistoryEntry),
    ProviderChanged(ProviderState),
    ChatChanged(ChatState),
    /// Coalesced to at most 20/s per chat while a text block streams.
    ChatEntryChanged(EntrySnapshot),
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum SaveError {
    Invalid { message: String },
    Keychain { message: String },
    Store { message: String },
}

/// A console whose transaction would be lost by a disconnect or close.
#[derive(Debug, Clone, Copy, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenTxn {
    pub tab_id: TabId,
    pub has_writes: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum DisconnectError {
    OpenTransactions { tabs: Vec<OpenTxn> },
    Store { message: String },
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum CatalogError {
    NotConnected,
    /// Not in `pg_database` as last read.
    UnknownDatabase { database: String },
    /// Neither the home database, a shown database, nor the database of a console. Consoles get
    /// their catalog through the console path, so a frontend bug cannot open a session per database.
    NotShown { database: String },
    /// The metadata session or the load failed. `CatalogStatus::Failed` carries the same message.
    Failed { message: String },
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum DetailError {
    Catalog { error: CatalogError },
    /// The relation was dropped after the catalog the caller holds was read.
    Gone,
    Failed { message: String },
}

/// One edit to a connection's stored view, sent by the pickers. Each is an intent that the engine
/// resolves against its own current database list and catalogs, so two quick clicks cannot lose
/// an update the way a selection computed from a stale snapshot would. Every edit is idempotent.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum ViewEdit {
    Databases { preset: Preset },
    /// One checkbox of the database picker. Showing a database whose stored schema selection
    /// resolves to no schema resets that selection to `DefaultOnly`.
    Database { name: String, shown: bool },
    ShowSystemDatabases { show: bool },
    Schemas { database: String, preset: Preset },
    /// One checkbox of the schema picker.
    Schema { database: String, name: String, shown: bool },
    ShowSystemSchemas { database: String, show: bool },
}

/// The quick actions of a picker. `None` is an explicit empty selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Type)]
pub enum Preset {
    All,
    DefaultOnly,
    None,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind")]
pub enum ConfigureError {
    /// Mode or connection change requested while a transaction is open.
    TransactionOpen,
    Busy,
    UnknownConnection,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum RunError {
    Busy,
    NoStatement,
    NotConfigured,
    /// `what` names the construct, e.g. `"COPY FROM STDIN"`.
    Unsupported { what: String },
    Connect { error: ConnectError },
    /// WHERE or ORDER BY isn't a single expression, e.g. it smuggles in a second statement.
    BadFilter,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind")]
pub enum TxnError {
    Busy,
    NoTransaction,
    RolledBack,
    Query(QueryError),
}

#[derive(Debug, Clone, Copy, Serialize, Type)]
#[serde(tag = "kind")]
pub enum ResultError {
    Gone,
    OutOfRange,
}

/// Staged edits to one table, applied together by `table_apply`. Rows to update or delete are found by primary key.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TableChanges {
    pub schema: String,
    pub table: String,
    /// Columns left out take their default.
    pub inserts: Vec<Vec<CellWrite>>,
    pub updates: Vec<RowUpdate>,
    /// Each entry is the primary key of a row to delete.
    pub deletes: Vec<Vec<CellWrite>>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CellWrite {
    pub column: String,
    /// Postgres text input for the column's type; `None` is NULL.
    pub value: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RowUpdate {
    pub key: Vec<CellWrite>,
    pub set: Vec<CellWrite>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum ChangeKind {
    Insert,
    Update,
    Delete,
}

/// Points at one entry of `TableChanges`, by its list and index there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRef {
    pub kind: ChangeKind,
    pub index: u32,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ApplySummary {
    /// False when the changes wait in the tab's open transaction (manual mode) for Commit.
    pub committed: bool,
}

/// Nothing is applied when any of these comes back.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum ApplyError {
    Busy,
    NotConfigured,
    Connect { error: ConnectError },
    /// The tab's transaction already failed; roll it back first.
    TransactionAborted,
    /// Updates and deletes need the table's full primary key.
    NoPrimaryKey,
    Failed { change: ChangeRef, error: QueryError },
    /// An update or delete matched `rows` rows instead of one, so the row changed underneath.
    RowMismatch { change: ChangeRef, rows: u64 },
    /// Opening or committing the transaction failed.
    Transaction { error: QueryError },
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum CountError {
    NotConnected,
    Failed { message: String },
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum ExportError {
    Gone,
    Io { message: String },
}

/// Minted by the frontend (`crypto.randomUUID()`), like `TabId`. A chat reaches the store with its
/// first message; until then it is a draft held in memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct ChatId(pub Uuid);

/// Engine-wide monotonic. Lives only while the turn that asked for it runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct ApprovalId(pub u64);

/// The provider's id for one tool use (`toolu_…` for Claude). Opaque outside the codec.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct ToolCallId(pub String);

/// A model as its provider names it on its command line (`opus`). Valid only against the last probe.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct ModelId(pub String);

/// An effort level as its provider names it (`high`). Valid only for a model that lists it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct EffortId(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Type)]
pub enum ProviderKind {
    Claude,
}

impl ProviderKind {
    /// `Settings.providers` holds one config per kind, in this order.
    pub const ALL: [ProviderKind; 1] = [ProviderKind::Claude];
}

pub fn default_config(kind: ProviderKind) -> ProviderConfig {
    match kind {
        ProviderKind::Claude => ProviderConfig {
            provider: kind,
            enabled: true,
            display_name: "Claude".into(),
            binary_path: String::new(),
            config_dir: String::new(),
            launch_args: String::new(),
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub provider: ProviderKind,
    pub enabled: bool,
    pub display_name: String,
    /// Empty means the provider's binary name, looked up on the login shell's PATH. `~` expands.
    pub binary_path: String,
    /// Empty means the inherited environment variable, else the provider's default directory.
    pub config_dir: String,
    /// Extra arguments as typed. The provider drops the flags the engine owns.
    pub launch_args: String,
}

// Hand-written so a config saved before a field existed loads with that field's default.
impl<'de> Deserialize<'de> for ProviderConfig {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Stored {
            provider: ProviderKind,
            enabled: Option<bool>,
            display_name: Option<String>,
            binary_path: Option<String>,
            config_dir: Option<String>,
            launch_args: Option<String>,
        }
        let s = Stored::deserialize(d)?;
        let default = default_config(s.provider);
        Ok(Self {
            provider: s.provider,
            enabled: s.enabled.unwrap_or(default.enabled),
            display_name: s.display_name.unwrap_or(default.display_name),
            binary_path: s.binary_path.unwrap_or(default.binary_path),
            config_dir: s.config_dir.unwrap_or(default.config_dir),
            launch_args: s.launch_args.unwrap_or(default.launch_args),
        })
    }
}

/// What never changes for a kind. The settings page and the composer render from it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub default_name: String,
    pub default_binary: String,
    /// The environment variable that names the config directory: `CLAUDE_CONFIG_DIR`.
    pub config_env: String,
    pub config_dir_default: String,
    pub sign_in_command: String,
    /// Launch-argument flags the engine ignores, listed under the field.
    pub owned_flags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderState {
    /// Not `kind`: `AppEvent` is tagged on `kind`.
    pub provider: ProviderKind,
    pub rev: u64,
    pub info: ProviderInfo,
    /// The engine-owned flags in the saved launch arguments, as typed, which it drops.
    pub ignored_flags: Vec<String>,
    /// A probe runs. `outcome` stays on screen meanwhile.
    pub checking: bool,
    /// When the last probe finished.
    pub checked_at_ms: Option<i64>,
    /// `None` until the first probe finishes.
    pub outcome: Option<ProbeOutcome>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum ProbeOutcome {
    /// `plan` reads like `"Claude Max"`.
    Ready { version: String, plan: Option<String>, models: Vec<ModelOption> },
    SignedOut { version: String },
    /// `binary` is what was looked up, and where.
    NotFound { binary: String },
    /// Found, but the version check, the sign-in check, or the handshake failed or timed out.
    Broken { version: Option<String>, message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: ModelId,
    /// `"Opus 5.5"`.
    pub label: String,
    pub description: String,
    /// Empty when the model takes no effort setting.
    pub efforts: Vec<EffortOption>,
    /// New chats start on it.
    pub recommended: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EffortOption {
    pub id: EffortId,
    /// `"High"`, `"Extra high"`.
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum Permission {
    /// Every `run_query` waits for Run or Deny.
    AskFirst,
    /// A read that calls only vetted built-in functions runs without asking. Anything else asks,
    /// with `ApprovalReason::Unvetted` naming what.
    Auto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatOptions {
    pub provider: ProviderKind,
    pub model: ModelId,
    pub effort: Option<EffortId>,
    pub permission: Permission,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatState {
    pub id: ChatId,
    /// From one engine-wide counter that every chat and entry snapshot shares.
    pub rev: u64,
    /// The first line of the first message, cut at 60 chars. Empty for a draft.
    pub title: String,
    pub updated_at_ms: i64,
    pub options: ChatOptions,
    pub status: ChatStatus,
    /// Entries are numbered `0..entry_count`.
    pub entry_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum ChatStatus {
    /// Opened, never sent to. Not stored, not listed.
    Draft,
    Idle,
    /// `turn` is the seq of the user entry that started it.
    Running { turn: u32, started_at_ms: i64, phase: TurnPhase },
    /// A tombstone, so the live store drops the chat by the same keep-higher rule.
    Deleted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum TurnPhase {
    Starting,
    Working,
    AwaitingApproval,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatView {
    pub state: ChatState,
    /// Every entry in seq order, the running turn's as of now.
    pub entries: Vec<EntrySnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EntrySnapshot {
    pub chat_id: ChatId,
    pub seq: u32,
    pub rev: u64,
    /// The seq of the user entry that opened this entry's turn. A user entry names itself.
    pub turn: u32,
    pub entry: Entry,
}

/// Stored verbatim in `chat_entries.json`. A stored row this build cannot parse loads as `Unreadable`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum Entry {
    User { at_ms: i64, text: String, context: Option<SentContext>, attachment: Option<Attachment> },
    Text { blocks: Vec<ReplyBlock>, done: bool },
    Tool { call: ToolCallId, tool: ToolUse, status: ToolStatus },
    /// Shown when the engine had to change course, such as a lost provider session.
    Notice { text: String },
    /// Closes every turn.
    End { at_ms: i64, outcome: TurnOutcome, suggestions: Vec<String> },
    Unreadable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SentContext {
    pub db: Option<DatabaseRef>,
    /// As named at send, so the chip reads right after a rename or a delete.
    pub connection_name: Option<String>,
    pub tab_title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub tab_title: String,
    pub columns: Vec<String>,
    /// What the model saw: at most 100 rows, cells cut at 200 chars.
    pub rows: Vec<Vec<Option<String>>>,
    pub total_rows: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum ReplyBlock {
    Markdown { text: String },
    /// A fenced SQL block. `relations` and `writes` are filled when the fence closes.
    Sql { sql: String, relations: Vec<String>, writes: bool, complete: bool },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum ToolUse {
    DescribeTables { tables: Vec<String> },
    SearchCatalog { query: String },
    RunQuery { sql: String, purpose: String, relations: Vec<String> },
    /// A tool the engine does not serve. Always refused.
    Other { name: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum ToolStatus {
    Running,
    AwaitingApproval { approval: ApprovalId, reason: ApprovalReason },
    Done { result: ToolResult },
    /// `message` is what the model got.
    Failed { message: String },
    /// `stopped` is true when Stop denied it, false when the user pressed Deny.
    Denied { stopped: bool },
    /// The turn ended before an answer.
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum ApprovalReason {
    AskFirst,
    /// The query uses what the engine cannot vouch for as read-only: the called functions off
    /// its allowlist, as written, plus `U& escape` or `SELECT INTO`. Auto asks for these too.
    Unvetted { functions: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum ToolResult {
    Described { found: Vec<String>, missing: Vec<String> },
    Found { matches: u16 },
    /// The preview the model saw. `more` is true when the query had more rows.
    Rows { columns: Vec<String>, rows: Vec<Vec<Option<String>>>, more: bool, elapsed_ms: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum TurnOutcome {
    Completed,
    Stopped,
    /// The app quit or crashed mid-turn. Written when the chat next opens.
    Lost,
    Failed { error: AgentError },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum AgentError {
    NotFound { binary: String },
    SignedOut,
    /// `detail` is the end of its stderr.
    Exited { code: Option<i32>, detail: String },
    /// An API failure, a rate limit, an overload.
    Provider { message: String },
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    pub text: String,
    pub tab: Option<TabContext>,
}

/// The active tab when the user pressed Send. The engine reads SQL out of `text` itself.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TabContext {
    pub tab_id: TabId,
    pub title: String,
    pub db: Option<DatabaseRef>,
    pub text: String,
    /// UTF-16 offsets, as for `RunRequest::Script`.
    pub target: RunTarget,
    /// The result the tab shows, when the attach button is on.
    pub attach: Option<ResultRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TurnAccepted {
    /// The seq of the stored user entry.
    pub turn: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Type)]
pub enum Decision {
    Run,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum SendError {
    Busy,
    EmptyMessage,
    ProviderOff { provider: ProviderKind },
    /// The chat's model left the provider's list since it was picked.
    UnknownModel { model: ModelId },
    /// A newer run replaced the attached result.
    AttachmentGone,
    Store { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum ChatError {
    UnknownModel { model: ModelId },
    UnsupportedEffort { effort: EffortId },
    Store { message: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind")]
pub enum ApproveError {
    /// Answered already, denied by Stop, expired, or another chat's.
    NotPending,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn struct_variant_fields_are_camel_case_and_tags_keep_variant_names() {
        let err = CatalogError::UnknownDatabase { database: "reporting".into() };
        assert_eq!(serde_json::to_value(err).unwrap(), json!({ "kind": "UnknownDatabase", "database": "reporting" }));
        let status = CatalogStatus::Ready { version: 3 };
        assert_eq!(serde_json::to_value(status).unwrap(), json!({ "kind": "Ready", "version": 3 }));
    }

    #[test]
    fn tabs_saved_before_they_carried_a_database_load_with_none() {
        let tab: TabSnapshot = serde_json::from_value(json!({
            "kind": "Table", "id": "00000000-0000-0000-0000-000000000001", "connectionId": "00000000-0000-0000-0000-000000000002",
            "schema": "public", "table": "orders", "page": 0
        }))
        .unwrap();
        assert_eq!(tab.console.database, None);
        let console: ConsoleConfigSnapshot =
            serde_json::from_value(json!({ "connectionId": "00000000-0000-0000-0000-000000000002", "schema": null, "mode": "Manual" })).unwrap();
        assert_eq!((console.database, console.mode), (None, TxnMode::Manual));
    }

    const TAB: &str = "00000000-0000-0000-0000-000000000001";
    const CONN: &str = "00000000-0000-0000-0000-000000000002";

    fn uuid(s: &str) -> Uuid {
        s.parse().unwrap()
    }

    #[test]
    fn an_old_table_tab_loads_as_an_auto_commit_tab_bound_to_its_table() {
        let tab: TabSnapshot = serde_json::from_value(json!({
            "kind": "Table", "id": TAB, "connectionId": CONN, "database": "shop",
            "schema": "public", "table": "orders", "page": 2, "query": { "orderBy": "id", "filters": [], "where": "" }
        }))
        .unwrap();
        assert_eq!((tab.id, tab.title.as_str(), tab.text), (TabId(uuid(TAB)), "orders", None));
        assert_eq!(
            (tab.console.connection_id, tab.console.database.as_deref(), tab.console.schema, tab.console.mode),
            (Some(ConnectionId(uuid(CONN))), Some("shop"), None, TxnMode::AutoCommit)
        );
        let query = TableQuery { order_by: "id".into(), ..Default::default() };
        assert_eq!(tab.table, Some(TableSnapshot { schema: "public".into(), table: "orders".into(), page: 2, query }));
    }

    #[test]
    fn an_old_sql_tab_loads_with_its_text_and_no_table() {
        let tab: TabSnapshot = serde_json::from_value(json!({
            "kind": "Sql", "id": TAB, "title": "q.sql", "text": "select 1",
            "console": { "connectionId": CONN, "database": "reporting", "schema": null, "mode": "Manual" }
        }))
        .unwrap();
        assert_eq!((tab.title.as_str(), tab.text.as_deref(), tab.table), ("q.sql", Some("select 1"), None));
        assert_eq!((tab.console.database.as_deref(), tab.console.mode), (Some("reporting"), TxnMode::Manual));
    }

    #[test]
    fn a_tab_round_trips_its_text_mode_and_table() {
        let value = json!({
            "id": TAB, "title": "orders", "text": "select * from orders",
            "console": { "connectionId": CONN, "database": "shop", "schema": null, "mode": "Manual" },
            "table": { "schema": "public", "table": "orders", "page": 1, "query": { "orderBy": "", "filters": [], "where": "total > 0" } }
        });
        let tab: TabSnapshot = serde_json::from_value(value.clone()).unwrap();
        assert_eq!((tab.text.as_deref(), tab.console.mode), (Some("select * from orders"), TxnMode::Manual));
        assert_eq!(tab.table.as_ref().map(|t| (t.page, t.query.r#where.as_str())), Some((1, "total > 0")));
        assert_eq!(serde_json::to_value(&tab).unwrap(), value);

        let plain = json!({
            "id": TAB, "title": "Untitled-1.sql", "text": "",
            "console": { "connectionId": null, "database": null, "schema": null, "mode": "AutoCommit" }, "table": null
        });
        let tab: TabSnapshot = serde_json::from_value(plain.clone()).unwrap();
        assert_eq!(serde_json::to_value(&tab).unwrap(), plain);
        assert_eq!(tab.table, None);
    }

    #[test]
    fn settings_saved_before_theme_existed_load_with_default_themes() {
        let s: Settings = serde_json::from_value(json!({
            "maxRows": 10, "maxResultBytes": 20, "tablePageSize": 30, "stopOnError": false
        }))
        .unwrap();
        assert_eq!((s.max_rows, s.table_page_size, s.stop_on_error, s.color_scheme), (10, 30, false, ColorScheme::System));
        assert_eq!((s.light_theme.as_str(), s.dark_theme.as_str(), s.custom_themes.len()), ("l1-light", "l1-dark", 0));
        assert_eq!(
            (s.interface_font, s.code_font, s.density, s.panel_motion_ms),
            (
                FontSetting { family: "Inter".into(), size: 13 },
                FontSetting { family: "JetBrains Mono".into(), size: 13 },
                Density::Standard,
                150
            )
        );
        assert!(!s.tint_connections);
    }

    #[test]
    fn settings_round_trip_appearance_fields() {
        let s = Settings {
            interface_font: FontSetting { family: "System".into(), size: 15 },
            code_font: FontSetting { family: "Menlo".into(), size: 11 },
            density: Density::Compact,
            panel_motion_ms: 0,
            tint_connections: true,
            ..Settings::default()
        };
        let value = serde_json::to_value(&s).unwrap();
        assert_eq!(value["interfaceFont"], json!({ "family": "System", "size": 15 }));
        assert_eq!((value["density"].clone(), value["panelMotionMs"].clone()), (json!("Compact"), json!(0)));
        assert_eq!(value["tintConnections"], json!(true));
        let round: Settings = serde_json::from_value(value).unwrap();
        assert_eq!((round.code_font, round.density, round.panel_motion_ms), (FontSetting { family: "Menlo".into(), size: 11 }, Density::Compact, 0));
        assert!(round.tint_connections);
    }

    #[test]
    fn settings_saved_with_the_old_theme_key_keep_their_scheme() {
        let s: Settings = serde_json::from_value(json!({
            "maxRows": 10, "maxResultBytes": 20, "tablePageSize": 30, "stopOnError": false, "theme": "Dark"
        }))
        .unwrap();
        assert_eq!((s.color_scheme, s.light_theme.as_str(), s.dark_theme.as_str()), (ColorScheme::Dark, "l1-light", "l1-dark"));
    }

    #[test]
    fn settings_round_trip_custom_themes() {
        let variant = |id: &str, name: &str, appearance, background: &str| CustomThemeVariant {
            id: id.into(),
            name: name.into(),
            appearance,
            colors: BTreeMap::from([("background".into(), background.into()), ("accent".into(), "#e0a040".into())]),
        };
        let custom = CustomTheme {
            id: "custom-1".into(),
            name: "Dusk".into(),
            variants: vec![variant("custom-1-0", "Dusk Day", Appearance::Light, "#fafafa"), variant("custom-1-1", "Dusk Night", Appearance::Dark, "#101018")],
        };
        let s = Settings { color_scheme: ColorScheme::Light, dark_theme: "custom-1-1".into(), custom_themes: vec![custom.clone()], ..Settings::default() };
        let value = serde_json::to_value(&s).unwrap();
        assert_eq!(value["customThemes"][0]["name"], json!("Dusk"));
        assert_eq!(value["customThemes"][0]["variants"][1], json!({
            "id": "custom-1-1", "name": "Dusk Night", "appearance": "dark", "colors": { "accent": "#e0a040", "background": "#101018" }
        }));
        assert_eq!(value["colorScheme"], json!("Light"));
        let round: Settings = serde_json::from_value(value).unwrap();
        assert_eq!((round.color_scheme, round.dark_theme.as_str(), round.custom_themes), (ColorScheme::Light, "custom-1-1", vec![custom]));
    }

    #[test]
    fn run_request_tags_are_camel_case() {
        let req: RunRequest = serde_json::from_value(json!({
            "kind": "tablePage", "schema": "public", "table": "orders", "page": 2
        }))
        .unwrap();
        assert!(matches!(req, RunRequest::TablePage { page: 2, .. }));

        let target: RunTarget =
            serde_json::from_value(json!({ "kind": "cursor", "offset": 7 })).unwrap();
        assert!(matches!(target, RunTarget::Cursor { offset: DocOffset(7) }));
    }

    #[test]
    fn nested_connect_error_keeps_its_own_tag() {
        let err = RunError::Connect {
            error: ConnectError::MissingPassword,
        };
        assert_eq!(
            serde_json::to_value(err).unwrap(),
            json!({ "kind": "Connect", "error": { "kind": "MissingPassword" } })
        );
    }

    #[test]
    fn layout_saved_before_panel_widths_existed_still_loads() {
        let tab: TabSnapshot = serde_json::from_value(json!({
            "kind": "Table", "id": "00000000-0000-0000-0000-000000000001", "connectionId": "00000000-0000-0000-0000-000000000002",
            "schema": "public", "table": "orders", "page": 3, "query": { "sort": [{ "column": "total", "desc": true }], "where": "x" }
        }))
        .unwrap();
        let kept = TableQuery { r#where: "x".into(), ..Default::default() };
        assert_eq!(tab.table.map(|t| (t.page, t.query)), Some((3, kept)), "an old query shape keeps what still fits");

        let layout: Layout = serde_json::from_value(json!({
            "sidebar": false, "results": false, "rightPanel": "History", "resultsHeight": 280
        }))
        .unwrap();
        assert!(!layout.sidebar);
        assert!(!layout.results);
        assert_eq!(layout.right_panel, Some(RightPanel::History));
        assert_eq!(layout.results_height, 280);
        assert_eq!(layout.sidebar_width, 256);
        assert_eq!(layout.right_panel_width, 341);
    }

    const CHAT: &str = "00000000-0000-0000-0000-000000000003";

    #[test]
    fn layout_saved_before_the_assistant_chat_existed_loads_with_none() {
        let saved = json!({ "sidebar": true, "results": true, "rightPanel": "Assistant", "resultsHeight": 320, "sidebarWidth": 256, "rightPanelWidth": 341 });
        let layout: Layout = serde_json::from_value(saved.clone()).unwrap();
        assert_eq!(layout.assistant_chat, None);
        let mut with_chat = saved;
        with_chat["assistantChat"] = json!(CHAT);
        let layout: Layout = serde_json::from_value(with_chat).unwrap();
        assert_eq!(layout.assistant_chat, Some(ChatId(uuid(CHAT))));
    }

    fn claude(enabled: bool, display_name: &str, binary_path: &str, config_dir: &str, launch_args: &str) -> ProviderConfig {
        ProviderConfig {
            provider: ProviderKind::Claude,
            enabled,
            display_name: display_name.into(),
            binary_path: binary_path.into(),
            config_dir: config_dir.into(),
            launch_args: launch_args.into(),
        }
    }

    #[test]
    fn settings_saved_before_providers_existed_load_the_claude_default() {
        let s: Settings = serde_json::from_value(json!({
            "maxRows": 10, "maxResultBytes": 20, "tablePageSize": 30, "stopOnError": false
        }))
        .unwrap();
        assert_eq!(s.providers, vec![claude(true, "Claude", "", "", "")]);
        assert_eq!(s.provider_health_check_secs, 300);
    }

    #[test]
    fn a_duplicate_provider_is_dropped_and_the_first_kept() {
        let first = json!({ "provider": "Claude", "enabled": false, "displayName": "Work", "binaryPath": "~/bin/claude", "configDir": "~/.claude-work", "launchArgs": "--debug" });
        let s: Settings = serde_json::from_value(json!({
            "maxRows": 10, "maxResultBytes": 20, "tablePageSize": 30, "stopOnError": false, "providerHealthCheckSecs": 0,
            "providers": [first, { "provider": "Claude", "enabled": true, "displayName": "Second", "binaryPath": "", "configDir": "", "launchArgs": "" }]
        }))
        .unwrap();
        assert_eq!(s.providers, vec![claude(false, "Work", "~/bin/claude", "~/.claude-work", "--debug")]);
        assert_eq!(s.provider_health_check_secs, 0);
        let value = serde_json::to_value(&s).unwrap();
        assert_eq!((value["providers"].clone(), value["providerHealthCheckSecs"].clone()), (json!([first]), json!(0)));
    }

    #[test]
    fn a_provider_config_saved_without_launch_args_loads_with_an_empty_string() {
        let config: ProviderConfig =
            serde_json::from_value(json!({ "provider": "Claude", "enabled": false, "displayName": "Claude", "binaryPath": "/opt/claude", "configDir": "" })).unwrap();
        assert_eq!(config, claude(false, "Claude", "/opt/claude", "", ""));
        let err = serde_json::from_value::<ProviderConfig>(json!({ "enabled": true })).unwrap_err();
        assert_eq!(err.to_string(), "missing field `provider`");
    }

    #[test]
    fn provider_changed_keeps_its_own_tag() {
        let state = ProviderState {
            provider: ProviderKind::Claude,
            rev: 4,
            info: ProviderInfo {
                default_name: "Claude".into(),
                default_binary: "claude".into(),
                config_env: "CLAUDE_CONFIG_DIR".into(),
                config_dir_default: "~/.claude".into(),
                sign_in_command: "claude auth login".into(),
                owned_flags: vec!["--verbose".into()],
            },
            ignored_flags: vec!["--verbose".into()],
            checking: true,
            checked_at_ms: Some(1700),
            outcome: Some(ProbeOutcome::SignedOut { version: "2.1.301".into() }),
        };
        assert_eq!(
            serde_json::to_value(AppEvent::ProviderChanged(state)).unwrap(),
            json!({
                "kind": "ProviderChanged", "provider": "Claude", "rev": 4,
                "info": {
                    "defaultName": "Claude", "defaultBinary": "claude", "configEnv": "CLAUDE_CONFIG_DIR",
                    "configDirDefault": "~/.claude", "signInCommand": "claude auth login", "ownedFlags": ["--verbose"]
                },
                "ignoredFlags": ["--verbose"],
                "checking": true, "checkedAtMs": 1700, "outcome": { "kind": "SignedOut", "version": "2.1.301" }
            })
        );
    }

    #[test]
    fn a_tool_entry_awaiting_approval_round_trips() {
        let value = json!({
            "kind": "Tool", "call": "toolu_01",
            "tool": { "kind": "RunQuery", "sql": "select pg_sleep(1)", "purpose": "wait", "relations": [] },
            "status": { "kind": "AwaitingApproval", "approval": 7, "reason": { "kind": "Unvetted", "functions": ["pg_sleep"] } }
        });
        let entry: Entry = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(
            entry,
            Entry::Tool {
                call: ToolCallId("toolu_01".into()),
                tool: ToolUse::RunQuery { sql: "select pg_sleep(1)".into(), purpose: "wait".into(), relations: vec![] },
                status: ToolStatus::AwaitingApproval { approval: ApprovalId(7), reason: ApprovalReason::Unvetted { functions: vec!["pg_sleep".into()] } },
            }
        );
        assert_eq!(serde_json::to_value(&entry).unwrap(), value);
    }
}

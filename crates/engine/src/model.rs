//! Every type that crosses IPC. `src/ipc/bindings.ts` is generated from this file.
//!
//! Struct fields and struct-variant fields are camelCase on the wire. Enum tags keep the
//! Rust variant name, except `RunRequest` and `RunTarget`, whose tags are camelCase.

use serde::{Deserialize, Serialize};
use specta::Type;
use uuid::Uuid;

// ---- identity ---------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct ConnectionId(pub Uuid);

/// Minted by the frontend (`crypto.randomUUID()`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct TabId(pub Uuid);

/// Engine-wide monotonic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
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

// ---- connection config --------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum SslMode {
    Disable,
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

/// Persisted (SQLite). Never contains the password.
#[derive(Debug, Clone, Serialize, Type)]
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

/// Edit semantics for the secret are explicit; the frontend never reads a password back.
#[derive(Debug, Clone, Deserialize, Type)]
pub enum PasswordInput {
    Keep,
    Set(String),
    Clear,
}

#[derive(Debug, Clone, Deserialize, Type)]
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

// ---- live connection --------------------------------------------------------

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    /// `"16.4"`
    pub version: String,
    pub version_num: u32,
    pub encoding: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum ConnStatus {
    Disconnected,
    Connecting,
    Connected { server: ServerInfo, catalog_version: u64 },
    /// The connect attempt failed.
    Failed { error: ConnectError },
    /// The metadata session died after being `Connected`.
    Lost { reason: String },
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

// ---- catalog (one snapshot per connection) -------------------------------------

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub connection_id: ConnectionId,
    pub version: u64,
    pub database: String,
    pub schemas: Vec<SchemaInfo>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub name: String,
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
    pub not_null: bool,
    pub pk: bool,
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

// ---- console (one per tab) -------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum TxnMode {
    AutoCommit,
    Manual,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleConfig {
    pub connection_id: ConnectionId,
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
    pub schema: Option<String>,
    pub mode: TxnMode,
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
    /// `done` is false while rows are still streaming.
    Rows { result: ResultMeta, done: bool },
    /// `tag` reads like `"UPDATE 3"`.
    Command { tag: String, elapsed_ms: u32 },
    Failed { error: QueryError },
    Cancelled,
    /// An earlier statement failed or was cancelled.
    Skipped,
}

// ---- run requests ---------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RunRequest {
    Script { text: String, target: RunTarget },
    /// The engine builds quoted SQL ordered by the catalog's PK columns (no ORDER BY without a PK).
    TablePage { schema: String, table: String, page: u32 },
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

// ---- results ------------------------------------------------------------------

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
    /// Hook for future inline editing.
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

/// Row-major page. Cells longer than the cell character limit (default 2,000) are cut;
/// `cut` lists their `(row, col)` so the UI can mark them and fetch the full value.
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
    /// Mapped from PG's 1-based character position into the document.
    pub position: Option<DocOffset>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub rows: u64,
    pub bytes: u64,
    pub truncated: bool,
}

// ---- output log (append-only) -------------------------------------------------

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OutputEntry {
    pub at_ms: i64,
    pub run_id: Option<RunId>,
    pub body: OutputBody,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum OutputBody {
    Notice {
        severity: String,
        message: String,
        detail: Option<String>,
    },
    Command {
        statement: u16,
        tag: String,
        elapsed_ms: u32,
    },
    Rows {
        statement: u16,
        rows: u64,
        elapsed_ms: u32,
        truncated: bool,
    },
    Error {
        statement: Option<u16>,
        error: QueryError,
    },
    /// `"BEGIN (implicit)"`, `"Session reset: connection was lost"`.
    Info { message: String },
}

// ---- history, workspace, settings -------------------------------------------------

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

#[derive(Debug, Clone, Serialize, Type)]
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

/// Owned by the frontend, stored verbatim by the engine (single writer: the UI).
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub tabs: Vec<TabSnapshot>,
    pub active: Option<TabId>,
    pub layout: Layout,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum TabSnapshot {
    Sql {
        id: TabId,
        title: String,
        text: String,
        console: ConsoleConfigSnapshot,
    },
    Table {
        id: TabId,
        connection_id: ConnectionId,
        schema: String,
        table: String,
        page: u32,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleConfigSnapshot {
    pub connection_id: Option<ConnectionId>,
    pub schema: Option<String>,
    pub mode: TxnMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub sidebar: bool,
    pub results: bool,
    pub right_panel: Option<RightPanel>,
    pub results_height: u16,
}

impl Default for Layout {
    fn default() -> Self {
        Self {
            sidebar: true,
            results: true,
            right_panel: None,
            results_height: 320,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum RightPanel {
    Assistant,
    Schema,
    History,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub max_rows: u32,
    pub max_result_bytes: u64,
    pub table_page_size: u32,
    pub stop_on_error: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            max_rows: 200_000,
            max_result_bytes: 512 * 1024 * 1024,
            table_page_size: 500,
            stop_on_error: true,
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
}

// ---- the one event (emitted as "app-event") -------------------------------------

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum AppEvent {
    ConnectionChanged(ConnectionState),
    CatalogChanged {
        connection_id: ConnectionId,
        version: u64,
    },
    /// Throttled to at most 10/s per console while streaming.
    ConsoleChanged(ConsoleState),
    ConsoleOutput {
        tab_id: TabId,
        entries: Vec<OutputEntry>,
    },
    HistoryAppended(HistoryEntry),
}

// ---- command errors ---------------------------------------------------------------

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
    Keychain { message: String },
    Store { message: String },
}

#[derive(Debug, Clone, Copy, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotConnected {
    pub connection_id: ConnectionId,
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

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum ExportError {
    Gone,
    Io { message: String },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn struct_variant_fields_are_camel_case_and_tags_keep_variant_names() {
        let ev = AppEvent::CatalogChanged {
            connection_id: ConnectionId(Uuid::nil()),
            version: 3,
        };
        assert_eq!(
            serde_json::to_value(ev).unwrap(),
            json!({ "kind": "CatalogChanged", "connectionId": Uuid::nil(), "version": 3 })
        );
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
}

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

/// A server message or a failure that no statement owns. Statement outcomes live in
/// `ConsoleState.run`, not here. `run_id` is the run, commit, rollback, or apply that held the
/// session; run ids share one counter, so `run_id >= run.run_id` means "this run or later".
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
    Notice {
        severity: String,
        message: String,
        detail: Option<String>,
    },
    Error { error: QueryError },
    Info { message: String },
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
        #[serde(default)]
        query: TableQuery,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleConfigSnapshot {
    pub connection_id: Option<ConnectionId>,
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
        }
    }
}

// Hand-written so workspaces saved before the panel widths existed still load. `#[serde(default)]`
// would do it too, but specta would then mark every Layout field optional in the TS bindings.
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
}

const DEFAULT_PANEL_MOTION_MS: u16 = 150;

const DEFAULT_LIGHT_THEME: &str = "l1-light";
const DEFAULT_DARK_THEME: &str = "l1-dark";

// Hand-written for the same reason as `TableQuery`: settings saved by older builds still load
// (`theme` became `colorScheme`; the theme, font, density, and motion fields came later), and the TS binding keeps every field required.
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
    }

    #[test]
    fn settings_round_trip_appearance_fields() {
        let s = Settings {
            interface_font: FontSetting { family: "System".into(), size: 15 },
            code_font: FontSetting { family: "Menlo".into(), size: 11 },
            density: Density::Compact,
            panel_motion_ms: 0,
            ..Settings::default()
        };
        let value = serde_json::to_value(&s).unwrap();
        assert_eq!(value["interfaceFont"], json!({ "family": "System", "size": 15 }));
        assert_eq!((value["density"].clone(), value["panelMotionMs"].clone()), (json!("Compact"), json!(0)));
        let round: Settings = serde_json::from_value(value).unwrap();
        assert_eq!((round.code_font, round.density, round.panel_motion_ms), (FontSetting { family: "Menlo".into(), size: 11 }, Density::Compact, 0));
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
        assert!(matches!(tab, TabSnapshot::Table { page: 3, query, .. } if query == kept), "an old query shape keeps what still fits");

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
}

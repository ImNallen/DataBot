use std::path::PathBuf;
use std::sync::Arc;

use engine::Engine;
use engine::model::*;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
#[specta::specta]
pub fn app_boot(engine: State<'_, Arc<Engine>>) -> BootSnapshot {
    engine.boot()
}

#[tauri::command]
#[specta::specta]
pub async fn connection_save(engine: State<'_, Arc<Engine>>, draft: ConnectionDraft) -> Result<ConnectionConfig, SaveError> {
    engine.save_connection(draft).await
}

#[tauri::command]
#[specta::specta]
pub async fn connection_delete(engine: State<'_, Arc<Engine>>, id: ConnectionId) -> Result<(), DisconnectError> {
    engine.delete_connection(id).await
}

#[tauri::command]
#[specta::specta]
pub async fn connection_test(engine: State<'_, Arc<Engine>>, draft: ConnectionDraft) -> Result<ServerInfo, ConnectError> {
    engine.test_connection(draft).await
}

#[tauri::command]
#[specta::specta]
pub fn connection_parse_url(engine: State<'_, Arc<Engine>>, url: String) -> Result<ConnectionDraft, String> {
    engine.parse_connection_url(&url)
}

#[tauri::command]
#[specta::specta]
pub async fn connection_connect(engine: State<'_, Arc<Engine>>, id: ConnectionId) -> Result<ServerInfo, ConnectError> {
    engine.connect(id).await
}

#[tauri::command]
#[specta::specta]
pub async fn connection_disconnect(engine: State<'_, Arc<Engine>>, id: ConnectionId, force: bool) -> Result<(), DisconnectError> {
    engine.disconnect(id, force).await
}

#[tauri::command]
#[specta::specta]
pub async fn catalog_get(engine: State<'_, Arc<Engine>>, db: DatabaseRef) -> Result<Arc<Catalog>, CatalogError> {
    engine.catalog(db).await
}

#[tauri::command]
#[specta::specta]
pub async fn catalog_refresh(engine: State<'_, Arc<Engine>>, db: DatabaseRef) -> Result<u64, CatalogError> {
    engine.refresh_catalog(db).await
}

#[tauri::command]
#[specta::specta]
pub async fn connection_refresh(engine: State<'_, Arc<Engine>>, id: ConnectionId) -> Result<(), CatalogError> {
    engine.refresh_connection(id).await
}

#[tauri::command]
#[specta::specta]
pub async fn connection_edit_view(engine: State<'_, Arc<Engine>>, id: ConnectionId, edit: ViewEdit) -> Result<(), CatalogError> {
    engine.edit_view(id, edit).await
}

#[tauri::command]
#[specta::specta]
pub fn connection_probe_databases(engine: State<'_, Arc<Engine>>, id: ConnectionId, databases: Vec<String>) {
    engine.probe_databases(id, databases)
}

#[tauri::command]
#[specta::specta]
pub async fn relation_detail(engine: State<'_, Arc<Engine>>, db: DatabaseRef, oid: u32) -> Result<RelationDetail, DetailError> {
    engine.relation_detail(db, oid).await
}

#[tauri::command]
#[specta::specta]
pub async fn exact_row_count(engine: State<'_, Arc<Engine>>, db: DatabaseRef, schema: String, table: String, query: TableQuery) -> Result<u64, CountError> {
    engine.exact_row_count(db, schema, table, query).await
}

#[tauri::command]
#[specta::specta]
pub async fn console_configure(engine: State<'_, Arc<Engine>>, tab_id: TabId, config: ConsoleConfig) -> Result<ConsoleState, ConfigureError> {
    engine.console_configure(tab_id, config).await
}

#[tauri::command]
#[specta::specta]
pub async fn console_run(engine: State<'_, Arc<Engine>>, tab_id: TabId, request: RunRequest) -> Result<RunAccepted, RunError> {
    engine.console_run(tab_id, request).await
}

// Async commands that borrow `State` must return `Result`; the owned `AppHandle` lifts that.
#[tauri::command]
#[specta::specta]
pub async fn console_cancel(app: AppHandle, tab_id: TabId) {
    app.state::<Arc<Engine>>().console_cancel(tab_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn console_commit(engine: State<'_, Arc<Engine>>, tab_id: TabId) -> Result<(), TxnError> {
    engine.console_commit(tab_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn console_rollback(engine: State<'_, Arc<Engine>>, tab_id: TabId) -> Result<(), TxnError> {
    engine.console_rollback(tab_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn table_apply(engine: State<'_, Arc<Engine>>, tab_id: TabId, changes: TableChanges) -> Result<ApplySummary, ApplyError> {
    engine.table_apply(tab_id, changes).await
}

#[tauri::command]
#[specta::specta]
pub async fn console_close(engine: State<'_, Arc<Engine>>, tab_id: TabId, force: bool) -> Result<(), DisconnectError> {
    engine.console_close(tab_id, force).await
}

#[tauri::command]
#[specta::specta]
pub fn result_page(engine: State<'_, Arc<Engine>>, result_ref: ResultRef, start: u32, len: u32) -> Result<RowPage, ResultError> {
    engine.result_page(result_ref, start, len)
}

#[tauri::command]
#[specta::specta]
pub fn result_cell(engine: State<'_, Arc<Engine>>, result_ref: ResultRef, row: u32, col: u16) -> Result<Option<String>, ResultError> {
    engine.result_cell(result_ref, row, col)
}

#[tauri::command]
#[specta::specta]
pub async fn result_export_csv(engine: State<'_, Arc<Engine>>, result_ref: ResultRef, path: String) -> Result<ExportSummary, ExportError> {
    engine.export_csv(result_ref, PathBuf::from(path)).await
}

#[tauri::command]
#[specta::specta]
pub fn history_list(engine: State<'_, Arc<Engine>>, query: HistoryQuery) -> HistoryPage {
    engine.history(query)
}

#[tauri::command]
#[specta::specta]
pub fn history_browse(
    engine: State<'_, Arc<Engine>>,
    query: HistoryBrowseQuery,
) -> Result<HistoryBrowsePage, HistoryError> {
    engine.history_browse(query)
}

#[tauri::command]
#[specta::specta]
pub fn history_group(
    engine: State<'_, Arc<Engine>>,
    query: HistoryGroupQuery,
) -> Result<HistoryGroupPage, HistoryError> {
    engine.history_group(query)
}

#[tauri::command]
#[specta::specta]
pub fn history_clear(engine: State<'_, Arc<Engine>>) {
    engine.clear_history()
}

#[tauri::command]
#[specta::specta]
pub fn workspace_save(engine: State<'_, Arc<Engine>>, workspace: Workspace) {
    engine.save_workspace(workspace)
}

#[tauri::command]
#[specta::specta]
pub fn settings_set(engine: State<'_, Arc<Engine>>, settings: Settings) {
    engine.set_settings(settings)
}

#[tauri::command]
#[specta::specta]
pub async fn assistant_open(engine: State<'_, Arc<Engine>>, chat_id: ChatId) -> Result<ChatView, ChatError> {
    engine.assistant_open(chat_id).await
}

#[tauri::command]
#[specta::specta]
pub fn assistant_configure(engine: State<'_, Arc<Engine>>, chat_id: ChatId, options: ChatOptions) -> Result<ChatState, ChatError> {
    engine.assistant_configure(chat_id, options)
}

#[tauri::command]
#[specta::specta]
pub async fn assistant_send(engine: State<'_, Arc<Engine>>, chat_id: ChatId, request: SendRequest) -> Result<TurnAccepted, SendError> {
    engine.assistant_send(chat_id, request).await
}

#[tauri::command]
#[specta::specta]
pub fn assistant_stop(engine: State<'_, Arc<Engine>>, chat_id: ChatId) {
    engine.assistant_stop(chat_id)
}

#[tauri::command]
#[specta::specta]
pub fn assistant_approve(engine: State<'_, Arc<Engine>>, chat_id: ChatId, approval: ApprovalId, decision: Decision) -> Result<(), ApproveError> {
    engine.assistant_approve(chat_id, approval, decision)
}

#[tauri::command]
#[specta::specta]
pub async fn assistant_delete(app: AppHandle, chat_id: ChatId) {
    app.state::<Arc<Engine>>().assistant_delete(chat_id).await
}

#[tauri::command]
#[specta::specta]
pub fn provider_refresh(engine: State<'_, Arc<Engine>>) {
    engine.provider_refresh()
}

#[tauri::command]
#[specta::specta]
pub async fn usage_limits(app: AppHandle) -> LimitsReport {
    app.state::<Arc<Engine>>().usage_limits().await
}

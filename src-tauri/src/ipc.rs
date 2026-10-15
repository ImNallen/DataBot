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

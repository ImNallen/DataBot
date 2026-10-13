//! The DataBot engine: every behavior behind the IPC commands, with no Tauri dependency.

mod catalog;
mod connection;
mod console;
pub mod model;
mod results;
mod secrets;
mod session;
mod sql;
mod store;
mod text;
mod txn;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::broadcast;

use model::*;
pub use secrets::{KeyringSecrets, MemorySecrets, SecretError, SecretStore};
pub use store::StoreError;

pub struct EngineConfig {
    pub data_dir: PathBuf,
    pub secrets: Arc<dyn SecretStore>,
}

pub struct Engine {
    config: EngineConfig,
    events: broadcast::Sender<AppEvent>,
}

const EVENT_BUFFER: usize = 1024;

#[allow(unused_variables)] // until the engine phase fills in the todo!() bodies
impl Engine {
    pub async fn open(cfg: EngineConfig) -> Result<Arc<Self>, StoreError> {
        tokio::fs::create_dir_all(&cfg.data_dir).await?;
        let (events, _) = broadcast::channel(EVENT_BUFFER);
        Ok(Arc::new(Self {
            config: cfg,
            events,
        }))
    }

    pub fn data_dir(&self) -> &Path {
        &self.config.data_dir
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent> {
        self.events.subscribe()
    }

    pub fn boot(&self) -> BootSnapshot {
        BootSnapshot {
            connections: Vec::new(),
            live: Vec::new(),
            consoles: Vec::new(),
            workspace: Workspace::default(),
            settings: Settings::default(),
        }
    }

    pub async fn save_connection(&self, d: ConnectionDraft) -> Result<ConnectionConfig, SaveError> {
        todo!()
    }

    pub async fn delete_connection(&self, id: ConnectionId) -> Result<(), DisconnectError> {
        todo!()
    }

    pub async fn test_connection(&self, d: ConnectionDraft) -> Result<ServerInfo, ConnectError> {
        todo!()
    }

    pub async fn connect(&self, id: ConnectionId) -> Result<ServerInfo, ConnectError> {
        todo!()
    }

    pub async fn disconnect(&self, id: ConnectionId, force: bool) -> Result<(), DisconnectError> {
        todo!()
    }

    pub fn catalog(&self, id: ConnectionId) -> Result<Arc<Catalog>, NotConnected> {
        todo!()
    }

    pub async fn refresh_catalog(&self, id: ConnectionId) -> Result<u64, NotConnected> {
        todo!()
    }

    pub async fn console_configure(
        &self,
        tab: TabId,
        c: ConsoleConfig,
    ) -> Result<ConsoleState, ConfigureError> {
        todo!()
    }

    pub async fn console_run(&self, tab: TabId, r: RunRequest) -> Result<RunAccepted, RunError> {
        todo!()
    }

    pub async fn console_cancel(&self, tab: TabId) {
        todo!()
    }

    pub async fn console_commit(&self, tab: TabId) -> Result<(), TxnError> {
        todo!()
    }

    pub async fn console_rollback(&self, tab: TabId) -> Result<(), TxnError> {
        todo!()
    }

    pub async fn console_close(&self, tab: TabId, force: bool) -> Result<(), DisconnectError> {
        todo!()
    }

    pub fn result_page(&self, r: ResultRef, start: u32, len: u32) -> Result<RowPage, ResultError> {
        todo!()
    }

    pub fn result_cell(&self, r: ResultRef, row: u32, col: u16) -> Result<Option<String>, ResultError> {
        todo!()
    }

    pub async fn export_csv(&self, r: ResultRef, path: PathBuf) -> Result<ExportSummary, ExportError> {
        todo!()
    }

    pub fn history(&self, q: HistoryQuery) -> HistoryPage {
        todo!()
    }

    pub fn clear_history(&self) {
        todo!()
    }

    pub fn save_workspace(&self, w: Workspace) {
        todo!()
    }

    pub fn set_settings(&self, s: Settings) {
        todo!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn open_creates_data_dir_and_boots_empty() {
        let dir = std::env::temp_dir().join(format!("databot-open-{}", uuid::Uuid::new_v4()));
        let engine = Engine::open(EngineConfig {
            data_dir: dir.join("nested"),
            secrets: Arc::new(MemorySecrets::default()),
        })
        .await
        .unwrap();
        assert!(engine.data_dir().is_dir());
        let boot = engine.boot();
        assert!(boot.connections.is_empty() && boot.consoles.is_empty());
        assert_eq!(boot.settings.max_rows, 200_000);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

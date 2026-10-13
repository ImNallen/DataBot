//! SQLite persistence: migrations, connections, history, and the kv table (workspace, settings).

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("data dir: {0}")]
    Io(#[from] std::io::Error),
}

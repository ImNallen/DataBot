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

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use tokio::sync::broadcast;

use connection::{ConnEntry, ConnSlot, ConnectParams, Live};
use console::{Console, PlannedStmt, RunPlan, SessionSlot};
use model::*;
use secrets::Vault;
use session::Session;
use store::{HistoryInsert, Store};

pub use connection::draft_from_url;
pub use secrets::{KeyStore, KeyringKeyStore, MemoryKeyStore, SecretError};
pub use store::StoreError;

pub struct EngineConfig {
    pub data_dir: PathBuf,
    pub keys: Arc<dyn KeyStore>,
}

pub struct Engine {
    shared: Arc<Shared>,
}

pub(crate) struct Shared {
    data_dir: PathBuf,
    vault: Vault,
    store: Store,
    settings: RwLock<Settings>,
    connections: RwLock<HashMap<ConnectionId, ConnEntry>>,
    consoles: RwLock<HashMap<TabId, Arc<Console>>>,
    events: broadcast::Sender<AppEvent>,
    next_run: AtomicU64,
    timezone: String,
}

const EVENT_BUFFER: usize = 1024;
const DB_FILE: &str = "l1-data.sqlite3";
const KV_WORKSPACE: &str = "workspace";
const KV_SETTINGS: &str = "settings";

impl Shared {
    pub(crate) fn emit(&self, ev: AppEvent) {
        let _ = self.events.send(ev);
    }

    pub(crate) fn settings(&self) -> Settings {
        self.settings.read().unwrap().clone()
    }

    fn next_run_id(&self) -> RunId {
        RunId(self.next_run.fetch_add(1, Ordering::Relaxed))
    }

    pub(crate) fn record_history(&self, h: HistoryInsert) {
        match self.store.insert_history_and_prune(h) {
            Ok(entry) => self.emit(AppEvent::HistoryAppended(entry)),
            Err(e) => eprintln!("history insert failed: {e}"),
        }
    }

    fn connection_state(&self, id: ConnectionId) -> Option<ConnectionState> {
        self.connections.read().unwrap().get(&id).map(|e| e.state(id))
    }

    fn set_connection(&self, id: ConnectionId, slot: ConnSlot) {
        let mut map = self.connections.write().unwrap();
        let entry = map.entry(id).or_insert(ConnEntry { rev: 0, slot: ConnSlot::Connecting });
        entry.rev += 1;
        entry.slot = slot;
        let state = entry.state(id);
        drop(map);
        self.emit(AppEvent::ConnectionChanged(state));
    }

    fn live(&self, id: ConnectionId) -> Option<Arc<Live>> {
        self.connections.read().unwrap().get(&id).and_then(ConnEntry::live)
    }

    fn config(&self, id: ConnectionId) -> Option<ConnectionConfig> {
        self.store.connections().ok()?.into_iter().find(|c| c.id == id)
    }

    fn connect_params(&self, id: ConnectionId) -> Result<(ConnectionConfig, ConnectParams), ConnectError> {
        let config = self.config(id).ok_or_else(|| ConnectError::Network { message: "unknown connection".into() })?;
        let password = if config.has_password {
            self.saved_password(id)?
        } else {
            None
        };
        let params = ConnectParams::from_config(&config, password);
        Ok((config, params))
    }

    fn saved_password(&self, id: ConnectionId) -> Result<Option<String>, ConnectError> {
        let keychain = |message: String| ConnectError::Keychain { message };
        let Some(sealed) = self.store.secret(id).map_err(|e| keychain(e.to_string()))? else { return Ok(None) };
        self.vault.open(id, &sealed).map_err(|e| keychain(e.to_string()))
    }

    fn all_consoles(&self) -> Vec<Arc<Console>> {
        self.consoles.read().unwrap().values().cloned().collect()
    }

    pub(crate) fn schedule_catalog_refresh(self: &Arc<Self>, id: ConnectionId) {
        let shared = self.clone();
        tokio::spawn(async move {
            let _ = shared.refresh_catalog(id).await;
        });
    }

    async fn refresh_catalog(&self, id: ConnectionId) -> Result<u64, NotConnected> {
        let live = self.live(id).ok_or(NotConnected { connection_id: id })?;
        let version = live.catalog.read().unwrap().version + 1;
        let database = live.catalog.read().unwrap().database.clone();
        let result = {
            let meta = live.meta.lock().await;
            catalog::load(&meta.client, id, version, database).await
        };
        match result {
            Ok(catalog) => {
                *live.catalog.write().unwrap() = Arc::new(catalog);
                self.republish_connection(id);
                self.emit(AppEvent::CatalogChanged { connection_id: id, version });
                Ok(version)
            }
            Err(e) => {
                let reason = live.meta.lock().await.closed_reason();
                match reason {
                    Some(reason) => self.mark_lost(id, &live, reason),
                    None => eprintln!("catalog refresh failed: {}", connection::error_text(&e)),
                }
                Err(NotConnected { connection_id: id })
            }
        }
    }

    fn republish_connection(&self, id: ConnectionId) {
        let mut map = self.connections.write().unwrap();
        let Some(entry) = map.get_mut(&id) else { return };
        entry.rev += 1;
        let state = entry.state(id);
        drop(map);
        self.emit(AppEvent::ConnectionChanged(state));
    }

    fn mark_lost(&self, id: ConnectionId, live: &Arc<Live>, reason: String) {
        let still_current = self
            .connections
            .read()
            .unwrap()
            .get(&id)
            .and_then(ConnEntry::live)
            .is_some_and(|l| Arc::ptr_eq(&l, live));
        if still_current {
            self.set_connection(id, ConnSlot::Lost(reason));
        }
    }

    fn watch_metadata_session(self: &Arc<Self>, id: ConnectionId, live: Arc<Live>, mut closed: tokio::sync::watch::Receiver<Option<String>>) {
        let shared = self.clone();
        tokio::spawn(async move {
            while closed.changed().await.is_ok() {
                if let Some(reason) = closed.borrow().clone() {
                    shared.mark_lost(id, &live, reason);
                    return;
                }
            }
        });
    }

    async fn connect(self: &Arc<Self>, id: ConnectionId) -> Result<ServerInfo, ConnectError> {
        loop {
            let connecting = match self.connections.read().unwrap().get(&id).map(|e| &e.slot) {
                Some(ConnSlot::Connected(live)) => return Ok(live.server.clone()),
                Some(ConnSlot::Connecting) => true,
                _ => false,
            };
            if !connecting {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        self.set_connection(id, ConnSlot::Connecting);
        match self.open_live(id).await {
            Ok(live) => {
                let server = live.server.clone();
                let closed = live.meta.lock().await.closed_watch();
                self.set_connection(id, ConnSlot::Connected(live.clone()));
                self.emit(AppEvent::CatalogChanged { connection_id: id, version: 1 });
                self.watch_metadata_session(id, live, closed);
                Ok(server)
            }
            Err(e) => {
                self.set_connection(id, ConnSlot::Failed(e.clone()));
                Err(e)
            }
        }
    }

    async fn open_live(&self, id: ConnectionId) -> Result<Arc<Live>, ConnectError> {
        let (config, params) = self.connect_params(id)?;
        let session = Session::open(&params, None, &self.timezone).await?;
        let catalog = catalog::load(&session.client, id, 1, config.database).await.map_err(connection::connect_error)?;
        Ok(Arc::new(Live {
            server: session.server.clone(),
            meta: tokio::sync::Mutex::new(session),
            catalog: RwLock::new(Arc::new(catalog)),
        }))
    }

    /// Consoles of `id` with an open transaction, with `has_writes` probed on their idle sessions.
    /// The probe takes the session out like a run does, so the lock is not held across the query.
    async fn open_transactions(&self, consoles: &[Arc<Console>]) -> Vec<OpenTxn> {
        let mut open = Vec::new();
        for console in consoles {
            let run_id = self.next_run_id();
            let taken = {
                let mut inner = console.inner.lock().await;
                if inner.txn == TxnState::Idle {
                    continue;
                }
                console.take_session(&mut inner, run_id)
            };
            let has_writes = match taken {
                None => true,
                Some((session, _stop)) => {
                    let has_writes = match session.client.simple_query("SELECT pg_current_xact_id_if_assigned() IS NOT NULL").await {
                        Ok(msgs) => msgs.iter().any(|m| matches!(m, tokio_postgres::SimpleQueryMessage::Row(r) if r.get(0) == Some("t"))),
                        Err(_) => true,
                    };
                    let lost = session.closed_reason();
                    let _ = console
                        .edit(self, run_id, |inner| {
                            let txn = inner.txn;
                            Console::return_session(inner, session, txn, lost);
                        })
                        .await;
                    has_writes
                }
            };
            open.push(OpenTxn { tab_id: console.tab, has_writes });
        }
        open
    }

    async fn console_txn_command(self: &Arc<Self>, tab: TabId, commit: bool) -> Result<(), TxnError> {
        let console = self.console(tab).ok_or(TxnError::NoTransaction)?;
        let run_id = self.next_run_id();
        let (mut session, aborted) = {
            let mut inner = console.inner.lock().await;
            match &inner.session {
                SessionSlot::Busy { .. } => return Err(TxnError::Busy),
                SessionSlot::Empty | SessionSlot::Lost { .. } => return Err(TxnError::NoTransaction),
                SessionSlot::Idle(_) if inner.txn == TxnState::Idle => return Err(TxnError::NoTransaction),
                SessionSlot::Idle(_) => {}
            }
            let aborted = inner.txn == TxnState::Aborted;
            let (session, _stop) = console.take_session(&mut inner, run_id).expect("slot is idle");
            (session, aborted)
        };
        let (kind, sql) = if commit && !aborted { (sql::StmtKind::Commit, "COMMIT") } else { (sql::StmtKind::Rollback, "ROLLBACK") };
        let result = session.client.batch_execute(sql).await;
        let fatal = result.as_ref().err().and_then(|e| e.as_db_error()).filter(|db| db.severity() == "FATAL").map(|db| db.message().to_owned());
        let lost = session.closed_reason_settled(fatal).await;
        for n in session.drain_notices() {
            console.output(self, None, console::notice_body(&n));
        }
        let outcome = if result.is_ok() { txn::StmtOutcome::Ok } else { txn::StmtOutcome::Err };
        let edited = console
            .edit(self, run_id, |inner| {
                let txn = txn::txn_after(inner.txn, &kind, outcome);
                Console::return_session(inner, session, txn, lost);
                let refresh = inner.ddl_pending && inner.txn == TxnState::Idle && commit && !aborted && result.is_ok();
                if inner.txn == TxnState::Idle {
                    inner.ddl_pending = false;
                }
                refresh.then_some(inner.config.connection_id)
            })
            .await;
        if let Ok(Some(connection_id)) = edited {
            self.schedule_catalog_refresh(connection_id);
        }
        match result {
            Ok(()) => {
                console.output(self, None, OutputBody::Command { statement: 0, tag: sql.into(), elapsed_ms: 0 });
                if commit && aborted { Err(TxnError::RolledBack) } else { Ok(()) }
            }
            Err(e) => {
                let error = e.as_db_error().map_or_else(|| connection::transport_error(&e), |db| connection::query_error(db, None));
                console.output(self, None, OutputBody::Error { statement: None, error: error.clone() });
                Err(TxnError::Query(error))
            }
        }
    }

    fn console(&self, tab: TabId) -> Option<Arc<Console>> {
        self.consoles.read().unwrap().get(&tab).cloned()
    }

    fn result_set(&self, r: ResultRef) -> Option<Arc<results::ResultSet>> {
        self.console(r.tab_id)?.result_set(r)
    }
}

impl Engine {
    pub async fn open(cfg: EngineConfig) -> Result<Arc<Self>, StoreError> {
        tokio::fs::create_dir_all(&cfg.data_dir).await?;
        let store = Store::open(&cfg.data_dir.join(DB_FILE))?;
        let settings = store.kv_get::<Settings>(KV_SETTINGS)?.unwrap_or_default();
        let (events, _) = broadcast::channel(EVENT_BUFFER);
        Ok(Arc::new(Self {
            shared: Arc::new(Shared {
                data_dir: cfg.data_dir,
                vault: Vault::new(cfg.keys),
                store,
                settings: RwLock::new(settings),
                connections: RwLock::new(HashMap::new()),
                consoles: RwLock::new(HashMap::new()),
                events,
                next_run: AtomicU64::new(1),
                timezone: iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".into()),
            }),
        }))
    }

    pub fn data_dir(&self) -> &Path {
        &self.shared.data_dir
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent> {
        self.shared.events.subscribe()
    }

    pub fn boot(&self) -> BootSnapshot {
        let s = &self.shared;
        let live = s.connections.read().unwrap().iter().map(|(id, e)| e.state(*id)).collect();
        let consoles = s.consoles.read().unwrap().values().map(|c| c.latest.lock().unwrap().clone()).collect();
        let connections = s.store.connections().unwrap_or_else(|e| {
            eprintln!("connections load failed: {e}");
            Vec::new()
        });
        let workspace = s.store.kv_get(KV_WORKSPACE).unwrap_or_else(|e| {
            eprintln!("workspace load failed: {e}");
            None
        });
        BootSnapshot { connections, live, consoles, workspace: workspace.unwrap_or_default(), settings: s.settings() }
    }

    pub async fn save_connection(&self, d: ConnectionDraft) -> Result<ConnectionConfig, SaveError> {
        let s = &self.shared;
        let invalid = |message: &str| SaveError::Invalid { message: message.into() };
        if d.name.trim().is_empty() {
            return Err(invalid("name is required"));
        }
        if d.host.trim().is_empty() {
            return Err(invalid("host is required"));
        }
        if d.port == 0 {
            return Err(invalid("port must be between 1 and 65535"));
        }
        if d.database.trim().is_empty() {
            return Err(invalid("database is required"));
        }
        if d.user.trim().is_empty() {
            return Err(invalid("user is required"));
        }
        let existing = d.id.and_then(|id| s.config(id));
        let id = d.id.unwrap_or_else(|| ConnectionId(uuid::Uuid::new_v4()));
        let store = |e: StoreError| SaveError::Store { message: e.to_string() };
        let has_password = match &d.password {
            PasswordInput::Set(pw) => {
                let sealed = s.vault.seal(id, pw).map_err(|e| SaveError::Keychain { message: e.to_string() })?;
                s.store.set_secret(id, &sealed).map_err(store)?;
                true
            }
            PasswordInput::Clear => {
                s.store.delete_secret(id).map_err(store)?;
                false
            }
            PasswordInput::Keep => existing.as_ref().is_some_and(|c| c.has_password),
        };
        let config = ConnectionConfig {
            id,
            name: d.name.trim().to_owned(),
            host: d.host.trim().to_owned(),
            port: d.port,
            database: d.database.trim().to_owned(),
            user: d.user.trim().to_owned(),
            ssl_mode: d.ssl_mode,
            ca_cert_path: d.ca_cert_path.filter(|p| !p.trim().is_empty()),
            has_password,
            color: d.color,
        };
        s.store.upsert_connection(&config).map_err(store)?;
        Ok(config)
    }

    pub async fn delete_connection(&self, id: ConnectionId) -> Result<(), DisconnectError> {
        self.disconnect(id, false).await?;
        let s = &self.shared;
        s.store.delete_connection(id).map_err(|e| DisconnectError::Store { message: e.to_string() })?;
        s.connections.write().unwrap().remove(&id);
        Ok(())
    }

    pub async fn test_connection(&self, d: ConnectionDraft) -> Result<ServerInfo, ConnectError> {
        let s = &self.shared;
        let password = match (&d.password, d.id) {
            (PasswordInput::Set(pw), _) => Some(pw.clone()),
            (PasswordInput::Clear, _) | (PasswordInput::Keep, None) => None,
            (PasswordInput::Keep, Some(id)) => s.saved_password(id)?,
        };
        let session = Session::open(&ConnectParams::from_draft(&d, password), None, &s.timezone).await?;
        Ok(session.server)
    }

    pub async fn connect(&self, id: ConnectionId) -> Result<ServerInfo, ConnectError> {
        self.shared.connect(id).await
    }

    pub async fn disconnect(&self, id: ConnectionId, force: bool) -> Result<(), DisconnectError> {
        let s = &self.shared;
        let consoles: Vec<Arc<Console>> = {
            let all = s.all_consoles();
            let mut mine = Vec::new();
            for c in all {
                if c.inner.lock().await.config.connection_id == id {
                    mine.push(c);
                }
            }
            mine
        };
        if !force {
            let open = s.open_transactions(&consoles).await;
            if !open.is_empty() {
                return Err(DisconnectError::OpenTransactions { tabs: open });
            }
        }
        for c in &consoles {
            c.drop_session(s).await;
        }
        if s.connection_state(id).is_some() {
            s.set_connection(id, ConnSlot::Disconnected);
        }
        Ok(())
    }

    pub fn catalog(&self, id: ConnectionId) -> Result<Arc<Catalog>, NotConnected> {
        let live = self.shared.live(id).ok_or(NotConnected { connection_id: id })?;
        let catalog = live.catalog.read().unwrap().clone();
        Ok(catalog)
    }

    pub async fn refresh_catalog(&self, id: ConnectionId) -> Result<u64, NotConnected> {
        self.shared.refresh_catalog(id).await
    }

    pub async fn console_configure(&self, tab: TabId, c: ConsoleConfig) -> Result<ConsoleState, ConfigureError> {
        let s = &self.shared;
        if s.config(c.connection_id).is_none() {
            return Err(ConfigureError::UnknownConnection);
        }
        let view = ConsoleConfigView { connection_id: c.connection_id, schema: c.schema, mode: c.mode };
        let console = {
            let mut map = s.consoles.write().unwrap();
            map.entry(tab).or_insert_with(|| Arc::new(Console::new(tab, view.clone()))).clone()
        };
        let mut inner = console.inner.lock().await;
        let connection_changed = inner.config.connection_id != view.connection_id;
        let mode_changed = inner.config.mode != view.mode;
        if connection_changed || mode_changed {
            if matches!(inner.session, SessionSlot::Busy { .. }) {
                return Err(ConfigureError::Busy);
            }
            if inner.txn != TxnState::Idle {
                return Err(ConfigureError::TransactionOpen);
            }
        }
        if connection_changed {
            inner.session = SessionSlot::Empty;
        }
        inner.config = view;
        Ok(console.publish(&mut inner, s))
    }

    pub async fn console_run(&self, tab: TabId, r: RunRequest) -> Result<RunAccepted, RunError> {
        let s = &self.shared;
        let console = s.console(tab).ok_or(RunError::NotConfigured)?;
        let (config, busy) = {
            let inner = console.inner.lock().await;
            (inner.config.clone(), matches!(inner.session, SessionSlot::Busy { .. }))
        };
        if busy {
            return Err(RunError::Busy);
        }
        s.connect(config.connection_id).await.map_err(|error| RunError::Connect { error })?;
        let connection = s.config(config.connection_id).ok_or(RunError::NotConfigured)?;

        let (text, spans) = match r {
            RunRequest::Script { text, target } => {
                let map = text::OffsetMap::new(&text);
                let target = match target {
                    RunTarget::All => sql::ByteTarget::All,
                    RunTarget::Cursor { offset } => sql::ByteTarget::Cursor(map.from_utf16(offset)),
                    RunTarget::Selection { from, to } => sql::ByteTarget::Selection { from: map.from_utf16(from), to: map.from_utf16(to) },
                };
                let spans = sql::pick(&sql::split_statements(&text), &text, target);
                (text, spans)
            }
            RunRequest::TablePage { schema, table, page } => {
                let catalog = self.catalog(config.connection_id).map_err(|_| RunError::NotConfigured)?;
                let pk = catalog.relation(&schema, &table).map(|r| r.pk_columns()).unwrap_or_default();
                let size = s.settings().table_page_size.max(1);
                let text = text::browse_sql(&schema, &table, &pk, size, u64::from(page) * u64::from(size));
                let spans = sql::split_statements(&text);
                (text, spans)
            }
        };
        if spans.is_empty() {
            return Err(RunError::NoStatement);
        }
        let statements: Vec<PlannedStmt> = spans.iter().map(|span| PlannedStmt { span: *span, kind: sql::classify(span.text(&text)) }).collect();
        if statements.iter().any(|p| p.kind == sql::StmtKind::CopyStdio) {
            return Err(RunError::Unsupported { what: "COPY FROM STDIN / TO STDOUT".into() });
        }
        let map = text::OffsetMap::new(&text);
        let ranges: Vec<DocRange> = spans.iter().map(|span| map.range(span)).collect();

        let mut fresh = None;
        let needs_session = matches!(console.inner.lock().await.session, SessionSlot::Empty | SessionSlot::Lost { .. });
        if needs_session {
            let (_, params) = s.connect_params(config.connection_id).map_err(|error| RunError::Connect { error })?;
            let session = Session::open(&params, config.schema.as_deref(), &s.timezone).await.map_err(|error| RunError::Connect { error })?;
            fresh = Some(session);
        }

        let run_id = s.next_run_id();
        let mut inner = console.inner.lock().await;
        if let Some(session) = fresh {
            match inner.session {
                SessionSlot::Empty | SessionSlot::Lost { .. } => inner.session = SessionSlot::Idle(session),
                SessionSlot::Idle(_) => {}
                SessionSlot::Busy { .. } => return Err(RunError::Busy),
            }
        }
        let Some((session, stop)) = console.take_session(&mut inner, run_id) else { return Err(RunError::Busy) };
        let txn = inner.txn;
        console.results.lock().unwrap().clear();
        inner.run = RunState::Running {
            run_id,
            started_at_ms: console::now_ms(),
            statements: ranges
                .iter()
                .enumerate()
                .map(|(i, range)| StatementRun { index: i as u16, range: *range, status: StmtStatus::Pending })
                .collect(),
        };
        console.publish(&mut inner, s);
        drop(inner);

        let plan = RunPlan { run_id, text, statements, mode: config.mode, txn, schema: config.schema.clone(), connection };
        tokio::spawn(console::run_task(console.clone(), s.clone(), session, plan, stop));
        Ok(RunAccepted { run_id, statements: ranges })
    }

    pub async fn console_cancel(&self, tab: TabId) {
        let Some(console) = self.shared.console(tab) else { return };
        let cancel = {
            let inner = console.inner.lock().await;
            match &inner.session {
                SessionSlot::Busy { cancel, stop, .. } => {
                    stop.store(true, Ordering::Relaxed);
                    Some(cancel.clone())
                }
                _ => None,
            }
        };
        if let Some(cancel) = cancel {
            cancel.cancel().await;
        }
    }

    pub async fn console_commit(&self, tab: TabId) -> Result<(), TxnError> {
        self.shared.console_txn_command(tab, true).await
    }

    pub async fn console_rollback(&self, tab: TabId) -> Result<(), TxnError> {
        self.shared.console_txn_command(tab, false).await
    }

    pub async fn console_close(&self, tab: TabId, force: bool) -> Result<(), DisconnectError> {
        let s = &self.shared;
        let Some(console) = s.console(tab) else { return Ok(()) };
        if !force {
            let open = s.open_transactions(std::slice::from_ref(&console)).await;
            if !open.is_empty() {
                return Err(DisconnectError::OpenTransactions { tabs: open });
            }
        }
        console.closed.store(true, Ordering::Relaxed);
        console.drop_session(s).await;
        s.consoles.write().unwrap().remove(&tab);
        Ok(())
    }

    pub fn result_page(&self, r: ResultRef, start: u32, len: u32) -> Result<RowPage, ResultError> {
        let set = self.shared.result_set(r).ok_or(ResultError::Gone)?;
        set.page(start, len).ok_or(ResultError::OutOfRange)
    }

    pub fn result_cell(&self, r: ResultRef, row: u32, col: u16) -> Result<Option<String>, ResultError> {
        let set = self.shared.result_set(r).ok_or(ResultError::Gone)?;
        set.cell(row, col).ok_or(ResultError::OutOfRange)
    }

    pub async fn export_csv(&self, r: ResultRef, path: PathBuf) -> Result<ExportSummary, ExportError> {
        let set = self.shared.result_set(r).ok_or(ExportError::Gone)?;
        tokio::task::spawn_blocking(move || {
            let file = std::fs::File::create(&path)?;
            let mut out = std::io::BufWriter::new(file);
            let summary = set.write_csv(&mut out)?;
            Ok::<_, std::io::Error>(ExportSummary { rows: summary.rows, bytes: summary.bytes, truncated: summary.truncated })
        })
        .await
        .map_err(|e| ExportError::Io { message: e.to_string() })?
        .map_err(|e| ExportError::Io { message: e.to_string() })
    }

    pub fn history(&self, q: HistoryQuery) -> HistoryPage {
        self.shared.store.history(&q).unwrap_or_else(|e| {
            eprintln!("history query failed: {e}");
            HistoryPage { entries: Vec::new(), has_more: false }
        })
    }

    pub fn clear_history(&self) {
        if let Err(e) = self.shared.store.clear_history() {
            eprintln!("history clear failed: {e}");
        }
    }

    pub fn save_workspace(&self, w: Workspace) {
        if let Err(e) = self.shared.store.kv_set(KV_WORKSPACE, &w) {
            eprintln!("workspace save failed: {e}");
        }
    }

    pub fn set_settings(&self, s: Settings) {
        if let Err(e) = self.shared.store.kv_set(KV_SETTINGS, &s) {
            eprintln!("settings save failed: {e}");
        }
        *self.shared.settings.write().unwrap() = s;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn engine() -> (Arc<Engine>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(EngineConfig {
            data_dir: dir.path().join("nested"),
            keys: Arc::new(MemoryKeyStore::default()),
        })
        .await
        .unwrap();
        (engine, dir)
    }

    fn draft(name: &str) -> ConnectionDraft {
        ConnectionDraft {
            id: None,
            name: name.into(),
            host: "localhost".into(),
            port: 5433,
            database: "shop".into(),
            user: "l1data".into(),
            ssl_mode: SslMode::Prefer,
            ca_cert_path: None,
            password: PasswordInput::Set("pw".into()),
            color: None,
        }
    }

    #[tokio::test]
    async fn open_creates_data_dir_and_boots_empty() {
        let (engine, _dir) = engine().await;
        assert!(engine.data_dir().is_dir());
        let boot = engine.boot();
        assert!(boot.connections.is_empty() && boot.consoles.is_empty());
        assert_eq!(boot.settings.max_rows, 200_000);
    }

    const PLAINTEXT: &str = "plaintext-hunter2";

    fn db_bytes(dir: &Path) -> Vec<u8> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with(DB_FILE))
            .flat_map(|p| std::fs::read(p).unwrap())
            .collect()
    }

    struct NoKeychain;

    impl KeyStore for NoKeychain {
        fn load(&self) -> Result<Option<[u8; 32]>, SecretError> {
            Err(SecretError("keychain touched".into()))
        }

        fn save(&self, _: &[u8; 32]) -> Result<(), SecretError> {
            Err(SecretError("keychain touched".into()))
        }
    }

    #[tokio::test]
    async fn passwordless_save_clear_and_delete_never_touch_the_keychain() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(EngineConfig { data_dir: dir.path().to_owned(), keys: Arc::new(NoKeychain) }).await.unwrap();
        let saved = engine.save_connection(ConnectionDraft { password: PasswordInput::Clear, ..draft("dev") }).await.unwrap();
        let kept = engine
            .save_connection(ConnectionDraft { id: Some(saved.id), password: PasswordInput::Keep, ..draft("dev") })
            .await
            .unwrap();
        assert!(!kept.has_password);
        engine.delete_connection(saved.id).await.unwrap();
        let err = engine.save_connection(draft("dev")).await.unwrap_err();
        assert!(matches!(err, SaveError::Keychain { ref message } if message == "keychain touched"));
    }

    #[tokio::test]
    async fn connections_settings_and_workspace_persist_across_open() {
        let dir = tempfile::tempdir().unwrap();
        let keys = Arc::new(MemoryKeyStore::default());
        let cfg = || EngineConfig { data_dir: dir.path().to_owned(), keys: keys.clone() };
        let password = |engine: &Engine, id| engine.shared.saved_password(id).unwrap();
        let saved = {
            let engine = Engine::open(cfg()).await.unwrap();
            let saved = engine
                .save_connection(ConnectionDraft { password: PasswordInput::Set(PLAINTEXT.into()), ..draft("dev") })
                .await
                .unwrap();
            assert!(saved.has_password);
            assert_eq!(password(&engine, saved.id).as_deref(), Some(PLAINTEXT));
            engine.set_settings(Settings { max_rows: 10, ..Settings::default() });
            engine.save_workspace(Workspace { tabs: vec![], active: None, layout: Layout { sidebar: false, ..Layout::default() } });
            saved
        };
        let engine = Engine::open(cfg()).await.unwrap();
        let boot = engine.boot();
        assert_eq!(boot.connections.len(), 1);
        assert_eq!(boot.connections[0].id, saved.id);
        assert_eq!(boot.settings.max_rows, 10);
        assert!(!boot.workspace.layout.sidebar);
        assert_eq!(password(&engine, saved.id).as_deref(), Some(PLAINTEXT));
        assert!(!db_bytes(dir.path()).windows(PLAINTEXT.len()).any(|w| w == PLAINTEXT.as_bytes()));

        let renamed = engine
            .save_connection(ConnectionDraft { id: Some(saved.id), name: "renamed".into(), password: PasswordInput::Keep, ..draft("x") })
            .await
            .unwrap();
        assert!(renamed.has_password && renamed.name == "renamed");
        assert_eq!(password(&engine, saved.id).as_deref(), Some(PLAINTEXT));
        let cleared = engine
            .save_connection(ConnectionDraft { id: Some(saved.id), password: PasswordInput::Clear, ..draft("x") })
            .await
            .unwrap();
        assert!(!cleared.has_password);
        assert_eq!(engine.shared.store.secret(saved.id).unwrap(), None);
        assert_eq!(password(&engine, saved.id), None);
        assert_eq!(engine.boot().connections.len(), 1);

        engine.delete_connection(saved.id).await.unwrap();
        assert!(engine.boot().connections.is_empty());
    }

    #[tokio::test]
    async fn invalid_drafts_are_rejected() {
        let (engine, _dir) = engine().await;
        let err = engine.save_connection(ConnectionDraft { name: "  ".into(), ..draft("x") }).await.unwrap_err();
        assert!(matches!(err, SaveError::Invalid { .. }));
        let err = engine.save_connection(ConnectionDraft { port: 0, ..draft("x") }).await.unwrap_err();
        assert!(matches!(err, SaveError::Invalid { .. }));
        assert!(engine.boot().connections.is_empty());
    }

    #[tokio::test]
    async fn console_requires_a_known_connection_and_results_are_gone_without_a_run() {
        let (engine, _dir) = engine().await;
        let tab = TabId(uuid::Uuid::new_v4());
        let unknown = ConsoleConfig { connection_id: ConnectionId(uuid::Uuid::new_v4()), schema: None, mode: TxnMode::AutoCommit };
        assert!(matches!(engine.console_configure(tab, unknown).await, Err(ConfigureError::UnknownConnection)));
        let r = ResultRef { tab_id: tab, run_id: RunId(1), index: 0 };
        assert!(matches!(engine.result_page(r, 0, 10), Err(ResultError::Gone)));
        assert!(matches!(engine.console_run(tab, RunRequest::Script { text: "select 1".into(), target: RunTarget::All }).await, Err(RunError::NotConfigured)));
        assert!(matches!(engine.console_commit(tab).await, Err(TxnError::NoTransaction)));
    }
}

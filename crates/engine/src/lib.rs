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

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock, Weak};
use std::time::Duration;

use tokio::sync::broadcast;

use connection::{CatalogSlot, ConnEntry, ConnSlot, ConnectParams, DbSlot, Instance};
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
    /// Engine-wide, so a reconnect never reissues a catalog version the UI has already seen.
    next_catalog_version: AtomicU64,
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

    fn instance(&self, id: ConnectionId) -> Option<Arc<Instance>> {
        self.connections.read().unwrap().get(&id).and_then(ConnEntry::instance)
    }

    fn config(&self, id: ConnectionId) -> Option<ConnectionConfig> {
        self.store.connections().ok()?.into_iter().find(|c| c.id == id)
    }

    fn params(&self, config: &ConnectionConfig, database: &str) -> Result<ConnectParams, ConnectError> {
        let password = if config.has_password { self.saved_password(config.id)? } else { None };
        Ok(ConnectParams::for_database(config, database, password))
    }

    /// Parameters for a console session on `database`, from the config as saved now.
    fn session_params(&self, id: ConnectionId, database: &str) -> Result<ConnectParams, ConnectError> {
        let config = self.config(id).ok_or_else(|| ConnectError::Network { message: "unknown connection".into() })?;
        self.params(&config, database)
    }

    fn next_catalog_version(&self) -> u64 {
        self.next_catalog_version.fetch_add(1, Ordering::Relaxed)
    }

    fn saved_password(&self, id: ConnectionId) -> Result<Option<String>, ConnectError> {
        let keychain = |message: String| ConnectError::Keychain { message };
        let Some(sealed) = self.store.secret(id).map_err(|e| keychain(e.to_string()))? else { return Ok(None) };
        self.vault.open(id, &sealed).map_err(|e| keychain(e.to_string()))
    }

    fn all_consoles(&self) -> Vec<Arc<Console>> {
        self.consoles.read().unwrap().values().cloned().collect()
    }

    /// Databases of `id` that must have a slot: the home database, the shown ones, and the
    /// database of every console on the connection.
    fn wanted(&self, instance: &Instance) -> BTreeSet<String> {
        let mut wanted = BTreeSet::from([instance.home.clone()]);
        for console in self.all_consoles() {
            let config = console.latest.lock().unwrap().config.clone();
            if config.connection_id == instance.config.id {
                wanted.insert(config.database);
            }
        }
        wanted
    }

    /// Converges the current instance's slots to `wanted` and starts a load for each slot not
    /// loaded yet.
    fn reconcile(self: &Arc<Self>, id: ConnectionId) {
        if let Some(instance) = self.instance(id) {
            self.reconcile_instance(&instance);
        }
    }

    fn reconcile_instance(self: &Arc<Self>, instance: &Arc<Instance>) {
        let id = instance.config.id;
        let wanted = self.wanted(instance);
        let opened = instance.converge(id, &wanted);
        self.republish_connection(id);
        for slot in opened {
            let shared = self.clone();
            let instance = instance.clone();
            tokio::spawn(async move {
                let _ = shared.ensure_catalog(&instance, &slot).await;
            });
        }
    }

    /// The slot of a wanted database, created on first use. The instance it converges is the one
    /// fetched here, so a reconnect in between cannot leave it without the slot; the slot is
    /// missing afterwards only when the instance closed or the database left `pg_database`.
    fn slot(self: &Arc<Self>, db: &DatabaseRef) -> Result<(Arc<Instance>, Arc<DbSlot>), CatalogError> {
        let instance = self.instance(db.connection_id).ok_or(CatalogError::NotConnected)?;
        if !instance.knows(&db.database) {
            return Err(CatalogError::UnknownDatabase { database: db.database.clone() });
        }
        if instance.slot(&db.database).is_none() {
            if !self.wanted(&instance).contains(&db.database) {
                return Err(CatalogError::NotShown { database: db.database.clone() });
            }
            self.reconcile_instance(&instance);
        }
        let slot = instance.slot(&db.database).ok_or_else(|| {
            if instance.knows(&db.database) { CatalogError::NotConnected } else { CatalogError::UnknownDatabase { database: db.database.clone() } }
        })?;
        Ok((instance, slot))
    }

    /// The Ready catalog, or one load of it. Loads of one database are single-flight: callers
    /// that arrive during a load wait for it and get its result.
    async fn ensure_catalog(self: &Arc<Self>, instance: &Arc<Instance>, slot: &Arc<DbSlot>) -> Result<Arc<Catalog>, CatalogError> {
        if let Some(catalog) = slot.ready() {
            return Ok(catalog);
        }
        let mut meta = slot.meta.lock().await;
        if let Some(catalog) = slot.ready() {
            return Ok(catalog);
        }
        self.load_catalog(instance, slot, &mut meta).await
    }

    /// One load under the slot's session lock. Opens the session when the slot has none.
    async fn load_catalog(self: &Arc<Self>, instance: &Arc<Instance>, slot: &DbSlot, meta: &mut Option<Session>) -> Result<Arc<Catalog>, CatalogError> {
        let id = instance.config.id;
        if slot.last().is_none() {
            slot.set(CatalogSlot::Opening);
            self.republish_connection(id);
        }
        let session = match self.session_in(instance, slot, meta).await {
            Ok(session) => session,
            Err(e) => {
                let message = connection::connect_error_text(&e);
                slot.fail(message.clone());
                self.republish_connection(id);
                return Err(CatalogError::Failed { message });
            }
        };
        let version = self.next_catalog_version();
        match catalog::load(&session.client, slot.db.clone(), version).await {
            Ok(catalog) => {
                let catalog = Arc::new(catalog);
                slot.set(CatalogSlot::Ready(catalog.clone()));
                self.republish_connection(id);
                Ok(catalog)
            }
            Err(e) => {
                let message = match session.closed_reason() {
                    Some(reason) => {
                        *meta = None;
                        reason
                    }
                    None => connection::error_text(&e),
                };
                slot.fail(message.clone());
                if slot.db.database == instance.home && meta.is_none() {
                    self.mark_lost(id, instance, message.clone());
                } else {
                    self.republish_connection(id);
                }
                Err(CatalogError::Failed { message })
            }
        }
    }

    /// The slot's open session, reopened if it died or was never opened.
    async fn session_in<'m>(self: &Arc<Self>, instance: &Arc<Instance>, slot: &DbSlot, meta: &'m mut Option<Session>) -> Result<&'m Session, ConnectError> {
        if meta.as_ref().is_some_and(|s| s.closed_reason().is_some()) {
            *meta = None;
        }
        if meta.is_none() {
            if instance.is_closed() {
                return Err(ConnectError::Network { message: "disconnected".into() });
            }
            let params = self.params(&instance.config, &slot.db.database)?;
            let session = Session::open(&params, None, &self.timezone).await?;
            self.watch_slot_session(instance, &slot.db, session.backend_pid, session.closed_watch());
            *meta = Some(session);
        }
        Ok(meta.as_ref().expect("opened above"))
    }

    fn republish_connection(&self, id: ConnectionId) {
        let mut map = self.connections.write().unwrap();
        let Some(entry) = map.get_mut(&id) else { return };
        entry.rev += 1;
        let state = entry.state(id);
        drop(map);
        self.emit(AppEvent::ConnectionChanged(state));
    }

    fn mark_lost(&self, id: ConnectionId, instance: &Arc<Instance>, reason: String) {
        let still_current = self.instance(id).is_some_and(|i| Arc::ptr_eq(&i, instance));
        if still_current {
            self.set_connection(id, ConnSlot::Lost(reason));
            instance.close();
        }
    }

    /// The home session's death loses the instance. Another slot's death fails only its database,
    /// and the next load on it reopens the session. The task holds the instance weakly: the
    /// session it watches lives inside the instance, so a strong handle would keep that session
    /// open past a disconnect.
    fn watch_slot_session(self: &Arc<Self>, instance: &Arc<Instance>, db: &DatabaseRef, backend_pid: i32, mut closed: tokio::sync::watch::Receiver<Option<String>>) {
        let shared = self.clone();
        let instance: Weak<Instance> = Arc::downgrade(instance);
        let db = db.clone();
        tokio::spawn(async move {
            while closed.changed().await.is_ok() {
                let Some(reason) = closed.borrow().clone() else { continue };
                let Some(instance) = instance.upgrade() else { return };
                if db.database == instance.home {
                    shared.mark_lost(db.connection_id, &instance, reason);
                } else if let Some(slot) = instance.slot(&db.database) {
                    let mut meta = slot.meta.lock().await;
                    if meta.as_ref().is_some_and(|s| s.backend_pid == backend_pid) {
                        *meta = None;
                        slot.fail(reason);
                        shared.republish_connection(db.connection_id);
                    }
                }
                return;
            }
        });
    }

    pub(crate) fn schedule_catalog_refresh(self: &Arc<Self>, db: DatabaseRef) {
        let Ok((instance, slot)) = self.slot(&db) else { return };
        if !slot.refresh.request() {
            return;
        }
        let shared = self.clone();
        tokio::spawn(async move {
            loop {
                let mut meta = slot.meta.lock().await;
                let _ = shared.load_catalog(&instance, &slot, &mut meta).await;
                drop(meta);
                if !slot.refresh.again() {
                    return;
                }
            }
        });
    }

    pub(crate) fn schedule_database_list_refresh(self: &Arc<Self>, id: ConnectionId) {
        let shared = self.clone();
        tokio::spawn(async move {
            let Some(instance) = shared.instance(id) else { return };
            let Some(home) = instance.slot(&instance.home) else { return };
            let mut meta = home.meta.lock().await;
            let Ok(session) = shared.session_in(&instance, &home, &mut meta).await else { return };
            match catalog::list_databases(&session.client).await {
                Ok((databases, _)) => {
                    *instance.databases.write().unwrap() = Arc::new(databases);
                    drop(meta);
                    shared.reconcile(id);
                }
                Err(e) => eprintln!("database list refresh failed: {}", connection::error_text(&e)),
            }
        });
    }

    async fn connect(self: &Arc<Self>, id: ConnectionId) -> Result<ServerInfo, ConnectError> {
        loop {
            let connecting = match self.connections.read().unwrap().get(&id).map(|e| &e.slot) {
                Some(ConnSlot::Connected(instance)) => return Ok(instance.server.clone()),
                Some(ConnSlot::Connecting) => true,
                _ => false,
            };
            if !connecting {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        self.set_connection(id, ConnSlot::Connecting);
        match self.open_instance(id).await {
            Ok((instance, home_pid, home_closed)) => {
                let server = instance.server.clone();
                self.set_connection(id, ConnSlot::Connected(instance.clone()));
                let home = DatabaseRef { connection_id: id, database: instance.home.clone() };
                self.watch_slot_session(&instance, &home, home_pid, home_closed);
                self.reconcile(id);
                Ok(server)
            }
            Err(e) => {
                self.set_connection(id, ConnSlot::Failed(e.clone()));
                Err(e)
            }
        }
    }

    /// Opens the home session and reads `pg_database`. Catalogs load afterwards, each on its own.
    async fn open_instance(&self, id: ConnectionId) -> Result<(Arc<Instance>, i32, tokio::sync::watch::Receiver<Option<String>>), ConnectError> {
        let config = self.config(id).ok_or_else(|| ConnectError::Network { message: "unknown connection".into() })?;
        let params = self.params(&config, &config.database)?;
        let session = Session::open(&params, None, &self.timezone).await?;
        let (databases, home) = catalog::list_databases(&session.client).await.map_err(connection::connect_error)?;
        let (server, pid, closed) = (session.server.clone(), session.backend_pid, session.closed_watch());
        let slot = DbSlot::new(DatabaseRef { connection_id: id, database: home.clone() });
        *slot.meta.lock().await = Some(session);
        Ok((Arc::new(Instance::new(config, server, home, databases, slot)), pid, closed))
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
        let started = std::time::Instant::now();
        let result = session.client.batch_execute(sql).await;
        let elapsed_ms = started.elapsed().as_millis().min(u32::MAX as u128) as u32;
        let fatal = result.as_ref().err().and_then(|e| e.as_db_error()).filter(|db| db.severity() == "FATAL").map(|db| db.message().to_owned());
        let lost = session.closed_reason_settled(fatal).await;
        let result = result.map_err(|e| e.as_db_error().map_or_else(|| connection::transport_error(&e), |db| connection::query_error(db, None)));
        let mut lines = vec![console::statement_line(0, sql)];
        lines.extend(console::notice_lines(&mut session));
        lines.push(match &result {
            Ok(()) => OutputBody::Command { statement: 0, tag: sql.into(), elapsed_ms },
            Err(error) => OutputBody::Error { statement: Some(0), error: error.clone() },
        });
        console.output_all(self, run_id, lines);
        let outcome = if result.is_ok() { txn::StmtOutcome::Ok } else { txn::StmtOutcome::Err };
        let edited = console
            .edit(self, run_id, |inner| {
                let txn = txn::txn_after(inner.txn, &kind, outcome);
                Console::return_session(inner, session, txn, lost);
                let refresh = inner.ddl_pending && inner.txn == TxnState::Idle && commit && !aborted && result.is_ok();
                if inner.txn == TxnState::Idle {
                    inner.ddl_pending = false;
                }
                refresh.then(|| inner.config.db())
            })
            .await;
        if let Ok(Some(db)) = edited {
            self.schedule_catalog_refresh(db);
        }
        match result {
            Ok(()) if commit && aborted => Err(TxnError::RolledBack),
            Ok(()) => Ok(()),
            Err(error) => Err(TxnError::Query(error)),
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
                next_catalog_version: AtomicU64::new(1),
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
        let instance = s.instance(id);
        if s.connection_state(id).is_some() {
            s.set_connection(id, ConnSlot::Disconnected);
        }
        if let Some(instance) = instance {
            instance.close();
        }
        Ok(())
    }

    /// The catalog of one database, loaded on first use. Only the home database, the shown ones,
    /// and the databases of this connection's consoles get a catalog.
    pub async fn catalog(&self, db: DatabaseRef) -> Result<Arc<Catalog>, CatalogError> {
        let (instance, slot) = self.shared.slot(&db)?;
        self.shared.ensure_catalog(&instance, &slot).await
    }

    pub async fn refresh_catalog(&self, db: DatabaseRef) -> Result<u64, CatalogError> {
        let (instance, slot) = self.shared.slot(&db)?;
        let mut meta = slot.meta.lock().await;
        Ok(self.shared.load_catalog(&instance, &slot, &mut meta).await?.version)
    }

    /// `count(*)` with the query's filters, on the database's metadata session.
    pub async fn exact_row_count(&self, db: DatabaseRef, schema: String, table: String, query: TableQuery) -> Result<u64, CountError> {
        let (instance, slot) = self.shared.slot(&db).map_err(|_| CountError::NotConnected)?;
        let sql = text::count_sql(&schema, &table, &query);
        if sql::split_statements(&sql).len() != 1 {
            return Err(CountError::Failed { message: "The filter must be a single expression.".into() });
        }
        let mut meta = slot.meta.lock().await;
        let session = self.shared.session_in(&instance, &slot, &mut meta).await.map_err(|e| CountError::Failed { message: connection::connect_error_text(&e) })?;
        let row = session.client.query_one(&sql, &[]).await.map_err(|e| CountError::Failed { message: connection::error_text(&e) })?;
        Ok(row.get::<_, i64>(0) as u64)
    }

    /// A connection, database, or mode change needs an idle tab with no open transaction. A
    /// connection or database change also resets the session.
    pub async fn console_configure(&self, tab: TabId, c: ConsoleConfig) -> Result<ConsoleState, ConfigureError> {
        let s = &self.shared;
        if s.config(c.connection_id).is_none() {
            return Err(ConfigureError::UnknownConnection);
        }
        let view = ConsoleConfigView { connection_id: c.connection_id, database: c.database, schema: c.schema, mode: c.mode };
        let console = {
            let mut map = s.consoles.write().unwrap();
            map.entry(tab).or_insert_with(|| Arc::new(Console::new(tab, view.clone()))).clone()
        };
        let mut inner = console.inner.lock().await;
        let previous = inner.config.connection_id;
        let target_changed = inner.config.connection_id != view.connection_id || inner.config.database != view.database;
        let mode_changed = inner.config.mode != view.mode;
        if target_changed || mode_changed {
            if matches!(inner.session, SessionSlot::Busy { .. }) {
                return Err(ConfigureError::Busy);
            }
            if inner.txn != TxnState::Idle {
                return Err(ConfigureError::TransactionOpen);
            }
        }
        if target_changed {
            inner.session = SessionSlot::Empty;
        }
        inner.config = view.clone();
        let state = console.publish(&mut inner, s);
        drop(inner);
        s.reconcile(view.connection_id);
        if previous != view.connection_id {
            s.reconcile(previous);
        }
        Ok(state)
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
            RunRequest::TablePage { schema, table, page, query } => {
                let catalog = self.catalog(config.db()).await.map_err(|_| RunError::NotConfigured)?;
                let pk = catalog.relation(&schema, &table).map(|r| r.pk_columns()).unwrap_or_default();
                let size = s.settings().table_page_size.max(1);
                let text = text::browse_sql(&schema, &table, &pk, &query, size, u64::from(page) * u64::from(size));
                let spans = sql::split_statements(&text);
                if spans.len() != 1 {
                    return Err(RunError::BadFilter);
                }
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
            let params = s.session_params(config.connection_id, &config.database).map_err(|error| RunError::Connect { error })?;
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

        let plan = RunPlan { run_id, text, statements, mode: config.mode, txn, schema: config.schema.clone(), database: config.database.clone(), connection };
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

    /// Applies staged table edits on the tab's own session, all or nothing. With no transaction open, auto-commit
    /// mode commits them and manual mode leaves them in a new open transaction. Inside an open transaction they
    /// run under a savepoint, so a failure leaves that transaction as it was.
    pub async fn table_apply(&self, tab: TabId, changes: TableChanges) -> Result<ApplySummary, ApplyError> {
        let s = &self.shared;
        let console = s.console(tab).ok_or(ApplyError::NotConfigured)?;
        let config = console.inner.lock().await.config.clone();
        s.connect(config.connection_id).await.map_err(|error| ApplyError::Connect { error })?;
        let catalog = self.catalog(config.db()).await.map_err(|_| ApplyError::NotConfigured)?;
        let pk = catalog.relation(&changes.schema, &changes.table).map(|r| r.pk_columns()).unwrap_or_default();
        let full_key = |key: &[CellWrite]| !pk.is_empty() && key.len() == pk.len() && pk.iter().all(|p| key.iter().any(|k| &k.column == p));
        if !changes.deletes.iter().all(|k| full_key(k)) || !changes.updates.iter().all(|u| full_key(&u.key)) {
            return Err(ApplyError::NoPrimaryKey);
        }

        let (schema, table) = (&changes.schema, &changes.table);
        let at = |kind, index: usize| ChangeRef { kind, index: index as u32 };
        let mut plan: Vec<(ChangeRef, String)> = Vec::new();
        plan.extend(changes.deletes.iter().enumerate().map(|(i, key)| (at(ChangeKind::Delete, i), text::delete_sql(schema, table, key))));
        plan.extend(
            changes.updates.iter().enumerate().filter(|(_, u)| !u.set.is_empty()).map(|(i, u)| (at(ChangeKind::Update, i), text::update_sql(schema, table, &u.key, &u.set))),
        );
        plan.extend(changes.inserts.iter().enumerate().map(|(i, cells)| (at(ChangeKind::Insert, i), text::insert_sql(schema, table, cells))));

        let needs_session = matches!(console.inner.lock().await.session, SessionSlot::Empty | SessionSlot::Lost { .. });
        let mut fresh = None;
        if needs_session {
            let params = s.session_params(config.connection_id, &config.database).map_err(|error| ApplyError::Connect { error })?;
            fresh = Some(Session::open(&params, config.schema.as_deref(), &s.timezone).await.map_err(|error| ApplyError::Connect { error })?);
        }

        let run_id = s.next_run_id();
        let (mut session, txn) = {
            let mut inner = console.inner.lock().await;
            if let Some(session) = fresh {
                match inner.session {
                    SessionSlot::Empty | SessionSlot::Lost { .. } => inner.session = SessionSlot::Idle(session),
                    SessionSlot::Idle(_) => {}
                    SessionSlot::Busy { .. } => return Err(ApplyError::Busy),
                }
            }
            if inner.txn == TxnState::Aborted {
                return Err(ApplyError::TransactionAborted);
            }
            let txn = inner.txn;
            let Some((session, _stop)) = console.take_session(&mut inner, run_id) else { return Err(ApplyError::Busy) };
            (session, txn)
        };

        let inside = txn == TxnState::Active;
        let (open, finish, undo) = if inside {
            ("SAVEPOINT l1_apply", Some("RELEASE SAVEPOINT l1_apply"), "ROLLBACK TO SAVEPOINT l1_apply; RELEASE SAVEPOINT l1_apply")
        } else {
            ("BEGIN", (config.mode == TxnMode::AutoCommit).then_some("COMMIT"), "ROLLBACK")
        };
        let as_query_error = |e: &tokio_postgres::Error| e.as_db_error().map_or_else(|| connection::transport_error(e), |db| connection::query_error(db, None));
        let mut lines = Vec::new();
        let outcome: Result<(), ApplyError> = async {
            session.client.batch_execute(open).await.map_err(|e| ApplyError::Transaction { error: as_query_error(&e) })?;
            for (i, (change, sql)) in plan.iter().enumerate() {
                let statement = i as u16;
                lines.push(console::statement_line(statement, sql));
                let started = std::time::Instant::now();
                let executed = session.client.execute(sql.as_str(), &[]).await;
                let elapsed_ms = started.elapsed().as_millis().min(u32::MAX as u128) as u32;
                lines.extend(console::notice_lines(&mut session));
                let rows = match executed {
                    Ok(rows) => rows,
                    Err(e) => {
                        let error = as_query_error(&e);
                        lines.push(OutputBody::Error { statement: Some(statement), error: error.clone() });
                        return Err(ApplyError::Failed { change: *change, error });
                    }
                };
                let verb = match change.kind {
                    ChangeKind::Insert => "INSERT 0",
                    ChangeKind::Update => "UPDATE",
                    ChangeKind::Delete => "DELETE",
                };
                lines.push(OutputBody::Command { statement, tag: format!("{verb} {rows}"), elapsed_ms });
                if change.kind != ChangeKind::Insert && rows != 1 {
                    return Err(ApplyError::RowMismatch { change: *change, rows });
                }
            }
            if let Some(finish) = finish {
                session.client.batch_execute(finish).await.map_err(|e| ApplyError::Transaction { error: as_query_error(&e) })?;
            }
            Ok(())
        }
        .await;
        if outcome.is_err() {
            let _ = session.client.batch_execute(undo).await;
        }
        let after = match (&outcome, inside, finish) {
            (_, true, _) => TxnState::Active,
            (Ok(()), false, None) => TxnState::Active,
            _ => TxnState::Idle,
        };
        let lost = session.closed_reason_settled(None).await;
        lines.extend(console::notice_lines(&mut session));
        if let Err(ApplyError::Transaction { error }) = &outcome {
            lines.push(OutputBody::Error { statement: None, error: error.clone() });
        }
        console.output_all(s, run_id, lines);
        let _ = console.edit(s, run_id, |inner| Console::return_session(inner, session, after, lost)).await;
        outcome.map(|()| ApplySummary { committed: after == TxnState::Idle })
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
        s.reconcile(console.latest.lock().unwrap().config.connection_id);
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

    pub fn settings(&self) -> Settings {
        self.shared.settings()
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
        let unknown = ConsoleConfig { connection_id: ConnectionId(uuid::Uuid::new_v4()), database: "shop".into(), schema: None, mode: TxnMode::AutoCommit };
        assert!(matches!(engine.console_configure(tab, unknown).await, Err(ConfigureError::UnknownConnection)));
        let r = ResultRef { tab_id: tab, run_id: RunId(1), index: 0 };
        assert!(matches!(engine.result_page(r, 0, 10), Err(ResultError::Gone)));
        assert!(matches!(engine.console_run(tab, RunRequest::Script { text: "select 1".into(), target: RunTarget::All }).await, Err(RunError::NotConfigured)));
        assert!(matches!(engine.console_commit(tab).await, Err(TxnError::NoTransaction)));
    }
}

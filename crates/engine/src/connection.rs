use std::collections::{BTreeSet, HashMap};
use std::error::Error as _;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use postgres_native_tls::MakeTlsConnector;
use tokio_postgres::config::Host;
use tokio_postgres::error::{DbError, ErrorPosition};

use crate::model::*;
use crate::session::Session;
use crate::view::{self, ConnectionView, Known};

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const KEEPALIVE_IDLE: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: Option<String>,
    pub ssl_mode: SslMode,
    pub ca_cert_path: Option<String>,
}

impl ConnectParams {
    /// The one place that chooses which database a session targets.
    pub fn for_database(c: &ConnectionConfig, database: &str, password: Option<String>) -> Self {
        Self {
            host: c.host.clone(),
            port: c.port,
            database: database.to_owned(),
            user: c.user.clone(),
            password,
            ssl_mode: c.ssl_mode,
            ca_cert_path: c.ca_cert_path.clone(),
        }
    }

    pub fn from_draft(d: &ConnectionDraft, password: Option<String>) -> Self {
        Self {
            host: d.host.clone(),
            port: d.port,
            database: d.database.clone(),
            user: d.user.clone(),
            password,
            ssl_mode: d.ssl_mode,
            ca_cert_path: d.ca_cert_path.clone(),
        }
    }

    pub fn pg_config(&self) -> tokio_postgres::Config {
        let mut cfg = tokio_postgres::Config::new();
        cfg.host(&self.host)
            .port(self.port)
            .dbname(&self.database)
            .user(&self.user)
            .application_name("L1 Data")
            .connect_timeout(CONNECT_TIMEOUT)
            .keepalives(true)
            .keepalives_idle(KEEPALIVE_IDLE)
            .ssl_mode(match self.ssl_mode {
                SslMode::Disable => tokio_postgres::config::SslMode::Disable,
                SslMode::Prefer => tokio_postgres::config::SslMode::Prefer,
                SslMode::Require | SslMode::VerifyCa | SslMode::VerifyFull => tokio_postgres::config::SslMode::Require,
            });
        if let Some(pw) = &self.password {
            cfg.password(pw);
        }
        cfg
    }

    /// libpq semantics: `require` encrypts without verifying, `verify-ca` checks the chain,
    /// `verify-full` also checks the host name.
    pub fn tls(&self) -> Result<MakeTlsConnector, ConnectError> {
        let mut builder = native_tls::TlsConnector::builder();
        match self.ssl_mode {
            SslMode::Disable | SslMode::Prefer | SslMode::Require => {
                builder.danger_accept_invalid_certs(true).danger_accept_invalid_hostnames(true);
            }
            SslMode::VerifyCa => {
                builder.danger_accept_invalid_hostnames(true);
            }
            SslMode::VerifyFull => {}
        }
        if let Some(path) = &self.ca_cert_path {
            let pem = std::fs::read(path).map_err(|e| ConnectError::Tls { message: format!("CA certificate {path}: {e}") })?;
            let cert = native_tls::Certificate::from_pem(&pem).map_err(|e| ConnectError::Tls { message: e.to_string() })?;
            builder.add_root_certificate(cert);
        }
        let connector = builder.build().map_err(|e| ConnectError::Tls { message: e.to_string() })?;
        Ok(MakeTlsConnector::new(connector))
    }
}

pub fn draft_from_url(url: &str, name: &str) -> Result<ConnectionDraft, String> {
    let cfg = tokio_postgres::Config::from_str(url).map_err(|e| error_text(&e))?;
    let host = match cfg.get_hosts().first() {
        Some(Host::Tcp(h)) => h.clone(),
        #[cfg(unix)]
        Some(Host::Unix(p)) => p.display().to_string(),
        None => "localhost".to_owned(),
    };
    let password = cfg
        .get_password()
        .map(|b| String::from_utf8(b.to_vec()).map_err(|e| e.to_string()))
        .transpose()?;
    Ok(ConnectionDraft {
        id: None,
        name: name.to_owned(),
        host,
        port: cfg.get_ports().first().copied().unwrap_or(5432),
        database: cfg.get_dbname().unwrap_or("postgres").to_owned(),
        user: cfg.get_user().unwrap_or("postgres").to_owned(),
        ssl_mode: match cfg.get_ssl_mode() {
            tokio_postgres::config::SslMode::Disable => SslMode::Disable,
            tokio_postgres::config::SslMode::Require => SslMode::Require,
            _ => SslMode::Prefer,
        },
        ca_cert_path: None,
        password: password.map_or(PasswordInput::Clear, PasswordInput::Set),
        color: None,
    })
}

/// tokio-postgres' `Display` names only the kind; the cause carries the useful part.
pub fn error_text(e: &tokio_postgres::Error) -> String {
    match e.source() {
        Some(src) => format!("{e}: {src}"),
        None => e.to_string(),
    }
}

pub fn connect_error_text(e: &ConnectError) -> String {
    match e {
        ConnectError::Network { message } | ConnectError::Tls { message } | ConnectError::Auth { message } | ConnectError::Keychain { message } => message.clone(),
        ConnectError::MissingPassword => "password missing".into(),
        ConnectError::Server(q) => q.message.clone(),
    }
}

pub fn connect_error(e: tokio_postgres::Error) -> ConnectError {
    if let Some(db) = e.as_db_error() {
        let code = db.code().code();
        return if code.starts_with("28") {
            ConnectError::Auth { message: db.message().to_owned() }
        } else {
            ConnectError::Server(query_error(db, None))
        };
    }
    let text = error_text(&e);
    let display = e.to_string();
    if display.contains("TLS") {
        ConnectError::Tls { message: text }
    } else if display == "invalid configuration" && text.contains("password missing") {
        ConnectError::MissingPassword
    } else {
        ConnectError::Network { message: text }
    }
}

pub fn query_error(db: &DbError, position: Option<DocOffset>) -> QueryError {
    QueryError {
        severity: db.severity().to_owned(),
        sqlstate: Some(db.code().code().to_owned()),
        message: db.message().to_owned(),
        detail: db.detail().map(str::to_owned),
        hint: db.hint().map(str::to_owned),
        context: db.where_().map(str::to_owned),
        position,
    }
}

pub fn original_position(db: &DbError) -> Option<u32> {
    match db.position() {
        Some(ErrorPosition::Original(n)) => Some(*n),
        _ => None,
    }
}

pub fn transport_error(e: &tokio_postgres::Error) -> QueryError {
    QueryError {
        severity: "ERROR".into(),
        sqlstate: None,
        message: error_text(e),
        detail: None,
        hint: None,
        context: None,
        position: None,
    }
}

pub struct PgDatabase {
    pub name: String,
    pub system: bool,
    pub access: DbAccess,
}

/// One connected instance. `slots[home]` lives as long as the instance and its session is the one
/// whose death marks the connection `Lost`. Every other slot is opened for a database the tree
/// shows or a console targets, and its session's death fails only that database.
///
/// Lock order, outermost first: `Shared::connections`, `slots`, `Shared::consoles`,
/// `Console::latest`, `databases`, `view`, `probes`, `show_checks`. A thread that holds one of
/// these takes only locks later in the list. `state()` walks the whole list under
/// `connections`, so a path that takes `probes` or `view` first and then `slots` deadlocks
/// against a snapshot.
pub struct Instance {
    pub config: ConnectionConfig,
    pub server: ServerInfo,
    pub home: String,
    pub databases: RwLock<Arc<Vec<PgDatabase>>>,
    /// The engine's copy of the stored view, written only by `Engine::edit_view` and the deferred
    /// show check in `load_catalog`.
    pub view: RwLock<ConnectionView>,
    pub slots: Mutex<HashMap<String, Arc<DbSlot>>>,
    /// Schema counts of databases without a slot, from `probe_databases`. Cleared by
    /// `refresh_connection`; dies with the instance.
    pub probes: Mutex<HashMap<String, SchemaCount>>,
    pub probe_gate: tokio::sync::Semaphore,
    /// Databases an edit showed while their catalog was unknown. After each one's first load the
    /// engine checks that its stored selection still resolves to a schema.
    pub show_checks: Mutex<BTreeSet<String>>,
    /// Set once the instance is disconnected or lost. A task that still holds the instance may
    /// finish its query, but it opens no session and converges no slot after this.
    closed: AtomicBool,
}

pub const PROBE_PERMITS: usize = 4;

/// The slots `converge` keeps and the ones it creates. `open` is a subset of `keep`: a shown
/// database past `view::AUTO_OPEN_LIMIT` is kept but gets its slot only when something asks for
/// its catalog.
pub struct Wanted {
    pub keep: BTreeSet<String>,
    pub open: BTreeSet<String>,
}

/// One metadata session and catalog for one database.
pub struct DbSlot {
    pub db: DatabaseRef,
    /// Opened on first use; `None` again after a loss until the next load reopens it. Loads and
    /// counts run under this lock, so concurrent loads of one database are single-flight.
    pub meta: tokio::sync::Mutex<Option<Session>>,
    pub catalog: RwLock<CatalogSlot>,
    pub refresh: RefreshGate,
}

pub enum CatalogSlot {
    Idle,
    /// The first load is in flight.
    Opening,
    Ready(Arc<Catalog>),
    /// Keeps the last good catalog so a failed refresh does not blank the tree.
    Failed { message: String, last: Option<Arc<Catalog>> },
}

impl DbSlot {
    pub fn new(db: DatabaseRef) -> Self {
        Self { db, meta: tokio::sync::Mutex::new(None), catalog: RwLock::new(CatalogSlot::Idle), refresh: RefreshGate::default() }
    }

    pub fn ready(&self) -> Option<Arc<Catalog>> {
        match &*self.catalog.read().unwrap() {
            CatalogSlot::Ready(c) => Some(c.clone()),
            _ => None,
        }
    }

    pub fn last(&self) -> Option<Arc<Catalog>> {
        match &*self.catalog.read().unwrap() {
            CatalogSlot::Ready(c) | CatalogSlot::Failed { last: Some(c), .. } => Some(c.clone()),
            _ => None,
        }
    }

    pub fn status(&self) -> CatalogStatus {
        match &*self.catalog.read().unwrap() {
            CatalogSlot::Idle => CatalogStatus::Idle,
            CatalogSlot::Opening => CatalogStatus::Loading,
            CatalogSlot::Ready(c) => CatalogStatus::Ready { version: c.version },
            CatalogSlot::Failed { message, last } => CatalogStatus::Failed { message: message.clone(), version: last.as_ref().map(|c| c.version) },
        }
    }

    pub fn set(&self, state: CatalogSlot) {
        *self.catalog.write().unwrap() = state;
    }

    pub fn fail(&self, message: String) {
        let last = self.last();
        self.set(CatalogSlot::Failed { message, last });
    }
}

/// Coalesces scheduled refreshes: while a load runs, further requests only mark it dirty, and the
/// running loop loads once more when it finishes. A burst of DDL costs at most two loads.
#[derive(Default)]
pub struct RefreshGate {
    state: Mutex<(bool, bool)>,
}

impl RefreshGate {
    /// True when the caller must run the load loop; false when a running loop will cover it.
    pub fn request(&self) -> bool {
        let mut g = self.state.lock().unwrap();
        let (running, dirty) = &mut *g;
        if *running {
            *dirty = true;
            false
        } else {
            *running = true;
            true
        }
    }

    /// After a load: true when another load is owed.
    pub fn again(&self) -> bool {
        let mut g = self.state.lock().unwrap();
        let (running, dirty) = &mut *g;
        if *dirty {
            *dirty = false;
            true
        } else {
            *running = false;
            false
        }
    }
}

impl Instance {
    pub fn new(config: ConnectionConfig, server: ServerInfo, home: String, databases: Vec<PgDatabase>, view: ConnectionView, home_slot: DbSlot) -> Self {
        Self {
            config,
            server,
            home: home.clone(),
            databases: RwLock::new(Arc::new(databases)),
            view: RwLock::new(view),
            slots: Mutex::new(HashMap::from([(home, Arc::new(home_slot))])),
            probes: Mutex::new(HashMap::new()),
            probe_gate: tokio::sync::Semaphore::new(PROBE_PERMITS),
            show_checks: Mutex::new(BTreeSet::new()),
            closed: AtomicBool::new(false),
        }
    }

    pub fn view(&self) -> ConnectionView {
        self.view.read().unwrap().clone()
    }

    /// The served catalog of every slot that has one: Ready, or the last good one behind Failed.
    pub fn catalogs(&self) -> HashMap<String, Arc<Catalog>> {
        served_catalogs(&self.slots.lock().unwrap())
    }

    pub fn slot_names(&self) -> Vec<String> {
        self.slots.lock().unwrap().keys().cloned().collect()
    }

    /// The databases the view shows, resolved against the current `pg_database` list.
    pub fn shown(&self) -> BTreeSet<String> {
        let databases = self.databases.read().unwrap().clone();
        let known = Known { home: &self.home, databases: &databases, catalogs: &HashMap::new() };
        view::resolve_databases(&self.view.read().unwrap(), &known)
    }

    pub fn slot(&self, database: &str) -> Option<Arc<DbSlot>> {
        self.slots.lock().unwrap().get(database).cloned()
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    /// Drops every slot, which closes each metadata session as soon as its last holder lets go,
    /// and stops the instance from opening another.
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.slots.lock().unwrap().clear();
    }

    pub fn knows(&self, database: &str) -> bool {
        self.databases.read().unwrap().iter().any(|d| d.name == database)
    }

    /// Converges the slots to `wanted`: drops the ones outside `keep`, which closes their
    /// sessions, creates the missing ones in `open`, and returns every slot whose catalog has not
    /// been loaded yet. Running it twice changes nothing. `wanted` runs under the slot lock, so
    /// a view written before this call is what it reads, and no converge can apply a set
    /// computed from an older view after one computed from a newer one.
    pub fn converge(&self, id: ConnectionId, wanted: impl FnOnce() -> Wanted) -> Vec<Arc<DbSlot>> {
        let mut slots = self.slots.lock().unwrap();
        if self.is_closed() {
            return Vec::new();
        }
        let wanted = wanted();
        slots.retain(|name, _| wanted.keep.contains(name));
        for name in &wanted.open {
            if !slots.contains_key(name) && self.knows(name) {
                slots.insert(name.clone(), Arc::new(DbSlot::new(DatabaseRef { connection_id: id, database: name.clone() })));
            }
        }
        slots.values().filter(|s| matches!(*s.catalog.read().unwrap(), CatalogSlot::Idle)).cloned().collect()
    }

    /// The tree's view of the instance, resolved from the database list, the stored view, each
    /// slot's served catalog, and the probe cache.
    pub fn state(&self) -> InstanceState {
        let slots = self.slots.lock().unwrap();
        let catalogs = served_catalogs(&slots);
        let list = self.databases.read().unwrap().clone();
        let view = self.view.read().unwrap();
        let probes = self.probes.lock().unwrap();
        let known = Known { home: &self.home, databases: &list, catalogs: &catalogs };
        let shown = view::resolve_databases(&view, &known);
        let databases = list
            .iter()
            .map(|d| {
                let entry = view.database(&d.name, &self.home);
                let catalog = catalogs.get(&d.name);
                DatabaseState {
                    name: d.name.clone(),
                    system: d.system,
                    access: d.access,
                    shown: shown.contains(&d.name),
                    show_system_schemas: entry.show_system_schemas,
                    shown_schemas: catalog.map(|c| view::resolve_schemas(&entry, c)).unwrap_or_default(),
                    schema_count: match catalog {
                        Some(c) => SchemaCount::Known { count: c.schemas.iter().filter(|s| !s.system).count() as u32 },
                        None => probes.get(&d.name).cloned().unwrap_or(SchemaCount::Unknown),
                    },
                    catalog: slots.get(&d.name).map_or(CatalogStatus::Idle, |s| s.status()),
                }
            })
            .collect();
        InstanceState { home: self.home.clone(), show_system_databases: view.show_system_databases, databases }
    }
}

fn served_catalogs(slots: &HashMap<String, Arc<DbSlot>>) -> HashMap<String, Arc<Catalog>> {
    slots.iter().filter_map(|(name, slot)| slot.last().map(|c| (name.clone(), c))).collect()
}

pub enum ConnSlot {
    Disconnected,
    Connecting,
    Connected(Arc<Instance>),
    Failed(ConnectError),
    Lost(String),
}

pub struct ConnEntry {
    pub rev: u64,
    pub slot: ConnSlot,
}

impl ConnEntry {
    pub fn state(&self, id: ConnectionId) -> ConnectionState {
        let status = match &self.slot {
            ConnSlot::Disconnected => ConnStatus::Disconnected,
            ConnSlot::Connecting => ConnStatus::Connecting,
            ConnSlot::Connected(instance) => ConnStatus::Connected { server: instance.server.clone(), instance: instance.state() },
            ConnSlot::Failed(error) => ConnStatus::Failed { error: error.clone() },
            ConnSlot::Lost(reason) => ConnStatus::Lost { reason: reason.clone() },
        };
        ConnectionState { id, rev: self.rev, status }
    }

    pub fn instance(&self) -> Option<Arc<Instance>> {
        match &self.slot {
            ConnSlot::Connected(instance) => Some(instance.clone()),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_reload_keeps_the_last_catalog_and_its_version() {
        let db = DatabaseRef { connection_id: ConnectionId(uuid::Uuid::nil()), database: "shop".into() };
        let slot = DbSlot::new(db.clone());
        slot.fail("first load failed".into());
        assert_eq!(slot.status(), CatalogStatus::Failed { message: "first load failed".into(), version: None });
        assert!(slot.last().is_none());

        let catalog = Arc::new(Catalog { db, version: 7, default_schema: None, schemas: Vec::new() });
        slot.set(CatalogSlot::Ready(catalog.clone()));
        slot.fail("statement timeout".into());
        assert_eq!(slot.status(), CatalogStatus::Failed { message: "statement timeout".into(), version: Some(7) });
        assert!(slot.ready().is_none());
        assert_eq!(slot.last().map(|c| c.version), Some(7));
    }

    #[test]
    fn url_becomes_a_draft() {
        let d = draft_from_url("postgres://l1data:s%40cret@db.example:5433/shop?sslmode=require", "dev").unwrap();
        assert_eq!((d.host.as_str(), d.port, d.database.as_str(), d.user.as_str()), ("db.example", 5433, "shop", "l1data"));
        assert!(matches!(d.password, PasswordInput::Set(ref p) if p == "s@cret"));
        assert_eq!(d.ssl_mode, SslMode::Require);
        let bare = draft_from_url("postgres://localhost/shop", "x").unwrap();
        assert_eq!((bare.port, bare.ssl_mode), (5432, SslMode::Prefer));
        assert!(matches!(bare.password, PasswordInput::Clear));
        assert!(draft_from_url("not a url", "x").is_err());
        assert_eq!(draft_from_url("postgres://:::", "").unwrap_err(), "invalid connection string: invalid value for option `port`");
    }
}

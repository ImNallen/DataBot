use std::error::Error as _;
use std::str::FromStr;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use postgres_native_tls::MakeTlsConnector;
use tokio_postgres::config::Host;
use tokio_postgres::error::{DbError, ErrorPosition};

use crate::model::*;
use crate::session::Session;

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
    pub fn from_config(c: &ConnectionConfig, password: Option<String>) -> Self {
        Self {
            host: c.host.clone(),
            port: c.port,
            database: c.database.clone(),
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
            .application_name("DataBot")
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

pub struct Live {
    pub server: ServerInfo,
    pub meta: tokio::sync::Mutex<Session>,
    pub catalog: RwLock<Arc<Catalog>>,
}

pub enum ConnSlot {
    Disconnected,
    Connecting,
    Connected(Arc<Live>),
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
            ConnSlot::Connected(live) => ConnStatus::Connected {
                server: live.server.clone(),
                catalog_version: live.catalog.read().unwrap().version,
            },
            ConnSlot::Failed(error) => ConnStatus::Failed { error: error.clone() },
            ConnSlot::Lost(reason) => ConnStatus::Lost { reason: reason.clone() },
        };
        ConnectionState { id, rev: self.rev, status }
    }

    pub fn live(&self) -> Option<Arc<Live>> {
        match &self.slot {
            ConnSlot::Connected(live) => Some(live.clone()),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_becomes_a_draft() {
        let d = draft_from_url("postgres://databot:s%40cret@db.example:5433/shop?sslmode=require", "dev").unwrap();
        assert_eq!((d.host.as_str(), d.port, d.database.as_str(), d.user.as_str()), ("db.example", 5433, "shop", "databot"));
        assert!(matches!(d.password, PasswordInput::Set(ref p) if p == "s@cret"));
        assert_eq!(d.ssl_mode, SslMode::Require);
        let bare = draft_from_url("postgres://localhost/shop", "x").unwrap();
        assert_eq!((bare.port, bare.ssl_mode), (5432, SslMode::Prefer));
        assert!(matches!(bare.password, PasswordInput::Clear));
        assert!(draft_from_url("not a url", "x").is_err());
    }
}

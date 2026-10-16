use std::future::poll_fn;
use std::time::Duration;

use postgres_native_tls::MakeTlsConnector;
use tokio::sync::{mpsc, watch};
use tokio_postgres::error::DbError;
use tokio_postgres::{AsyncMessage, CancelToken, Client, SimpleQueryMessage};

use crate::connection::{ConnectParams, connect_error, error_text};
use crate::model::{ConnectError, ServerInfo};
use crate::text::quote_ident;

pub struct Session {
    pub client: Client,
    pub backend_pid: i32,
    pub server: ServerInfo,
    pub search_path: Option<String>,
    cancel: CancelToken,
    tls: MakeTlsConnector,
    notices: mpsc::UnboundedReceiver<DbError>,
    closed: watch::Receiver<Option<String>>,
}

#[derive(Clone)]
pub struct CancelHandle {
    token: CancelToken,
    tls: MakeTlsConnector,
}

impl CancelHandle {
    pub async fn cancel(&self) {
        if let Err(e) = self.token.cancel_query(self.tls.clone()).await {
            eprintln!("cancel request failed: {}", error_text(&e));
        }
    }
}

impl Session {
    pub async fn open(p: &ConnectParams, schema: Option<&str>, timezone: &str) -> Result<Session, ConnectError> {
        let tls = p.tls()?;
        let (client, mut connection) = p.pg_config().connect(tls.clone()).await.map_err(connect_error)?;
        let (notice_tx, notices) = mpsc::unbounded_channel();
        let (closed_tx, closed) = watch::channel(None);
        tokio::spawn(async move {
            let reason = loop {
                match poll_fn(|cx| connection.poll_message(cx)).await {
                    Some(Ok(AsyncMessage::Notice(n))) => {
                        let _ = notice_tx.send(n);
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => break error_text(&e),
                    None => break "connection closed".to_owned(),
                }
            };
            let _ = closed_tx.send(Some(reason));
        });

        // An OS zone Postgres does not know is not worth failing the connection over.
        let _ = client.batch_execute(&format!("SET TimeZone = '{}'", timezone.replace('\'', "''"))).await;
        let server = server_info(&client).await.map_err(connect_error)?;
        let mut session = Session {
            backend_pid: server.1,
            server: server.0,
            search_path: None,
            cancel: client.cancel_token(),
            tls,
            notices,
            closed,
            client,
        };
        session.set_search_path(schema).await.map_err(connect_error)?;
        Ok(session)
    }

    /// A session for one assistant query. Its default is read-only, so a statement that somehow
    /// ran outside the query's `READ ONLY` transaction would still be refused.
    pub async fn open_assistant(p: &ConnectParams, timezone: &str) -> Result<Session, ConnectError> {
        let session = Session::open(p, None, timezone).await?;
        session.client.batch_execute("SET application_name = 'L1 Data assistant'; SET default_transaction_read_only = on").await.map_err(connect_error)?;
        Ok(session)
    }

    pub async fn set_search_path(&mut self, schema: Option<&str>) -> Result<(), tokio_postgres::Error> {
        if let Some(s) = schema {
            self.client.batch_execute(&format!("SET search_path TO {}", quote_ident(s))).await?;
        }
        self.search_path = schema.map(str::to_owned);
        Ok(())
    }

    pub fn cancel_handle(&self) -> CancelHandle {
        CancelHandle { token: self.cancel.clone(), tls: self.tls.clone() }
    }

    pub fn drain_notices(&mut self) -> Vec<DbError> {
        let mut out = Vec::new();
        while let Ok(n) = self.notices.try_recv() {
            out.push(n);
        }
        out
    }

    /// `Some(reason)` once the connection is dead. The client learns of a dead socket before the
    /// driver task records why, so a closed client without a reason yet gets a generic one.
    pub fn closed_reason(&self) -> Option<String> {
        self.closed.borrow().clone().or_else(|| self.client.is_closed().then(|| "connection closed".to_owned()))
    }

    /// Like `closed_reason`, but gives the driver task a moment to deliver the server's reason.
    /// A FATAL error answered to a statement (`terminating connection due to administrator
    /// command`) means the server is closing the socket; `fatal` carries that message so the
    /// session counts as dead even if EOF has not been read yet.
    pub async fn closed_reason_settled(&mut self, fatal: Option<String>) -> Option<String> {
        if self.closed.borrow().is_none() && (fatal.is_some() || self.client.is_closed()) {
            let _ = tokio::time::timeout(Duration::from_millis(500), self.closed.changed()).await;
        }
        self.closed.borrow().clone().or(fatal).or_else(|| self.closed_reason())
    }

    pub fn closed_watch(&self) -> watch::Receiver<Option<String>> {
        self.closed.clone()
    }
}

async fn server_info(client: &Client) -> Result<(ServerInfo, i32), tokio_postgres::Error> {
    let messages = client
        .simple_query(
            "SELECT pg_backend_pid()::text, current_setting('server_version'), current_setting('server_version_num'), current_setting('server_encoding')",
        )
        .await?;
    let row = messages.iter().find_map(|m| match m {
        SimpleQueryMessage::Row(r) => Some(r),
        _ => None,
    });
    let cell = |i: usize| row.and_then(|r| r.get(i)).unwrap_or("");
    let full_version = cell(1);
    Ok((
        ServerInfo {
            version: full_version.split_whitespace().next().unwrap_or(full_version).to_owned(),
            version_num: cell(2).parse().unwrap_or(0),
            encoding: cell(3).to_owned(),
        },
        cell(0).parse().unwrap_or(0),
    ))
}

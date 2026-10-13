//! SQLite persistence: migrations, connections, history, and the kv table (workspace, settings).

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::model::{ConnectionConfig, ConnectionId, HistoryEntry, HistoryOutcome, HistoryPage, HistoryQuery};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("data dir: {0}")]
    Io(#[from] std::io::Error),
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("stored json: {0}")]
    Json(#[from] serde_json::Error),
}

pub const HISTORY_KEEP: i64 = 10_000;

const MIGRATIONS: [&str; 1] = ["
    CREATE TABLE connections (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE history (
        id INTEGER PRIMARY KEY,
        at_ms INTEGER NOT NULL,
        connection_id TEXT NOT NULL,
        connection_name TEXT NOT NULL,
        database TEXT NOT NULL,
        sql TEXT NOT NULL,
        elapsed_ms INTEGER NOT NULL,
        outcome_json TEXT NOT NULL
    );
    CREATE INDEX history_connection ON history (connection_id, id);
    CREATE TABLE kv (key TEXT PRIMARY KEY, json TEXT NOT NULL);
"];

/// Writes are single-row and sub-millisecond, so every call runs inline under one mutex.
pub struct Store {
    conn: Mutex<Connection>,
}

/// A history row before it has an id.
pub struct HistoryInsert {
    pub at_ms: i64,
    pub connection_id: ConnectionId,
    pub connection_name: String,
    pub database: String,
    pub sql: String,
    pub elapsed_ms: u32,
    pub outcome: HistoryOutcome,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            conn.execute_batch(&format!("BEGIN; {sql} PRAGMA user_version = {}; COMMIT;", i + 1))?;
        }
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T, StoreError>) -> Result<T, StoreError> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        f(&conn)
    }

    pub fn connections(&self) -> Result<Vec<ConnectionConfig>, StoreError> {
        self.with(|c| {
            let mut stmt = c.prepare("SELECT json FROM connections ORDER BY rowid")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.map(|json| Ok(serde_json::from_str(&json?)?)).collect()
        })
    }

    pub fn upsert_connection(&self, config: &ConnectionConfig) -> Result<(), StoreError> {
        self.with(|c| {
            c.execute(
                "INSERT INTO connections (id, json) VALUES (?1, ?2) ON CONFLICT (id) DO UPDATE SET json = excluded.json",
                params![config.id.0.to_string(), serde_json::to_string(config)?],
            )?;
            Ok(())
        })
    }

    pub fn delete_connection(&self, id: ConnectionId) -> Result<(), StoreError> {
        self.with(|c| {
            c.execute("DELETE FROM connections WHERE id = ?1", [id.0.to_string()])?;
            Ok(())
        })
    }

    /// Inserts and prunes to the newest `HISTORY_KEEP` rows.
    pub fn insert_history(&self, h: HistoryInsert) -> Result<HistoryEntry, StoreError> {
        self.with(|c| {
            c.execute(
                "INSERT INTO history (at_ms, connection_id, connection_name, database, sql, elapsed_ms, outcome_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    h.at_ms,
                    h.connection_id.0.to_string(),
                    h.connection_name,
                    h.database,
                    h.sql,
                    h.elapsed_ms,
                    serde_json::to_string(&h.outcome)?
                ],
            )?;
            let id = c.last_insert_rowid();
            c.execute(
                "DELETE FROM history WHERE id <= (SELECT id FROM history ORDER BY id DESC LIMIT 1 OFFSET ?1)",
                [HISTORY_KEEP],
            )?;
            Ok(HistoryEntry {
                id,
                at_ms: h.at_ms,
                connection_id: h.connection_id,
                connection_name: h.connection_name,
                database: h.database,
                sql: h.sql,
                elapsed_ms: h.elapsed_ms,
                outcome: h.outcome,
            })
        })
    }

    /// Newest first, keyset-paginated on id.
    pub fn history(&self, q: &HistoryQuery) -> Result<HistoryPage, StoreError> {
        self.with(|c| {
            let limit = i64::from(q.limit.max(1));
            let pattern = q.text.as_deref().filter(|t| !t.trim().is_empty()).map(|t| format!("%{}%", t.trim()));
            let mut stmt = c.prepare(
                "SELECT id, at_ms, connection_id, connection_name, database, sql, elapsed_ms, outcome_json
                 FROM history
                 WHERE (?1 IS NULL OR id < ?1)
                   AND (?2 IS NULL OR connection_id = ?2)
                   AND (?3 IS NULL OR sql LIKE ?3)
                 ORDER BY id DESC LIMIT ?4",
            )?;
            let rows = stmt.query_map(
                params![q.before_id, q.connection_id.map(|id| id.0.to_string()), pattern, limit + 1],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, u32>(6)?,
                        r.get::<_, String>(7)?,
                    ))
                },
            )?;
            let mut entries = Vec::new();
            for row in rows {
                let (id, at_ms, connection_id, connection_name, database, sql, elapsed_ms, outcome) = row?;
                entries.push(HistoryEntry {
                    id,
                    at_ms,
                    connection_id: ConnectionId(connection_id.parse().map_err(|_| {
                        rusqlite::Error::InvalidColumnType(2, "connection_id".into(), rusqlite::types::Type::Text)
                    })?),
                    connection_name,
                    database,
                    sql,
                    elapsed_ms,
                    outcome: serde_json::from_str(&outcome)?,
                });
            }
            let has_more = entries.len() as i64 > limit;
            entries.truncate(limit as usize);
            Ok(HistoryPage { entries, has_more })
        })
    }

    pub fn clear_history(&self) -> Result<(), StoreError> {
        self.with(|c| {
            c.execute("DELETE FROM history", [])?;
            Ok(())
        })
    }

    pub fn kv_get<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>, StoreError> {
        self.with(|c| {
            let json: Option<String> =
                c.query_row("SELECT json FROM kv WHERE key = ?1", [key], |r| r.get(0)).optional()?;
            Ok(json.map(|j| serde_json::from_str(&j)).transpose()?)
        })
    }

    pub fn kv_set<T: Serialize>(&self, key: &str, value: &T) -> Result<(), StoreError> {
        self.with(|c| {
            c.execute(
                "INSERT INTO kv (key, json) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET json = excluded.json",
                params![key, serde_json::to_string(value)?],
            )?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Settings, SslMode};

    fn store() -> (Store, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        (Store::open(&dir.path().join("t.sqlite3")).unwrap(), dir)
    }

    fn entry(sql: &str) -> HistoryInsert {
        HistoryInsert {
            at_ms: 1,
            connection_id: ConnectionId(uuid::Uuid::nil()),
            connection_name: "dev".into(),
            database: "shop".into(),
            sql: sql.into(),
            elapsed_ms: 2,
            outcome: HistoryOutcome::Rows { rows: 1 },
        }
    }

    #[test]
    fn migrations_run_once_and_data_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.sqlite3");
        let config = ConnectionConfig {
            id: ConnectionId(uuid::Uuid::new_v4()),
            name: "dev".into(),
            host: "localhost".into(),
            port: 5433,
            database: "shop".into(),
            user: "databot".into(),
            ssl_mode: SslMode::Prefer,
            ca_cert_path: None,
            has_password: true,
            color: None,
        };
        {
            let s = Store::open(&path).unwrap();
            s.upsert_connection(&config).unwrap();
            s.kv_set("settings", &Settings { max_rows: 7, ..Settings::default() }).unwrap();
            s.insert_history(entry("select 1")).unwrap();
        }
        let s = Store::open(&path).unwrap();
        let loaded = s.connections().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!((loaded[0].id, loaded[0].port), (config.id, 5433));
        assert_eq!(s.kv_get::<Settings>("settings").unwrap().unwrap().max_rows, 7);
        assert!(s.kv_get::<Settings>("missing").unwrap().is_none());
        assert_eq!(s.history(&HistoryQuery { text: None, connection_id: None, before_id: None, limit: 10 }).unwrap().entries[0].sql, "select 1");
        s.delete_connection(config.id).unwrap();
        assert!(s.connections().unwrap().is_empty());
    }

    #[test]
    fn history_pages_newest_first_and_filters() {
        let (s, _dir) = store();
        for i in 0..5 {
            s.insert_history(entry(&format!("select {i}"))).unwrap();
        }
        let other = HistoryInsert { connection_id: ConnectionId(uuid::Uuid::new_v4()), ..entry("select other") };
        let other_id = other.connection_id;
        s.insert_history(other).unwrap();

        let page = s.history(&HistoryQuery { text: None, connection_id: None, before_id: None, limit: 2 }).unwrap();
        assert_eq!(page.entries.iter().map(|e| e.sql.as_str()).collect::<Vec<_>>(), ["select other", "select 4"]);
        assert!(page.has_more);
        let next = s.history(&HistoryQuery { text: None, connection_id: None, before_id: Some(page.entries[1].id), limit: 10 }).unwrap();
        assert_eq!(next.entries.len(), 4);
        assert!(!next.has_more);

        let filtered = s.history(&HistoryQuery { text: Some("other".into()), connection_id: Some(other_id), before_id: None, limit: 10 }).unwrap();
        assert_eq!(filtered.entries.len(), 1);
        assert_eq!(filtered.entries[0].connection_id, other_id);
        assert!(matches!(filtered.entries[0].outcome, HistoryOutcome::Rows { rows: 1 }));
        let none = s.history(&HistoryQuery { text: Some("zzz".into()), connection_id: None, before_id: None, limit: 10 }).unwrap();
        assert!(none.entries.is_empty());

        s.clear_history().unwrap();
        assert!(s.history(&HistoryQuery { text: None, connection_id: None, before_id: None, limit: 10 }).unwrap().entries.is_empty());
    }

    #[test]
    fn history_is_pruned_to_the_newest_rows() {
        let (s, _dir) = store();
        for i in 0..(HISTORY_KEEP + 5) {
            s.insert_history(entry(&format!("q{i}"))).unwrap();
        }
        let count: i64 = s.with(|c| Ok(c.query_row("SELECT count(*) FROM history", [], |r| r.get(0))?)).unwrap();
        assert_eq!(count, HISTORY_KEEP);
        let all = s.history(&HistoryQuery { text: None, connection_id: None, before_id: None, limit: u16::MAX }).unwrap();
        assert_eq!(all.entries.last().unwrap().sql, "q5", "the five oldest rows are gone");
    }
}

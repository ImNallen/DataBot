use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use rusqlite::functions::FunctionFlags;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::model::{ChatId, ChatOptions, ConnectionConfig, ConnectionId, Entry, HistoryEntry, HistoryOutcome, HistoryPage, HistoryQuery, ProviderKind};
use crate::secrets::Sealed;
use crate::view::ConnectionView;

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

const MIGRATIONS: [&str; 5] = [
    "
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
",
    "CREATE TABLE secrets (connection_id TEXT PRIMARY KEY, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL);",
    "CREATE TABLE connection_views (connection_id TEXT PRIMARY KEY, json TEXT NOT NULL);",
    "ALTER TABLE history ADD COLUMN is_write INTEGER NOT NULL DEFAULT 0;",
    "
    CREATE TABLE chats (id TEXT PRIMARY KEY, updated_ms INTEGER NOT NULL, json TEXT NOT NULL);
    CREATE INDEX chats_updated ON chats (updated_ms);
    CREATE TABLE chat_entries (
        chat_id TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        turn INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (chat_id, seq)
    ) WITHOUT ROWID;
",
];

pub struct Store {
    state: Mutex<StoreState>,
}

struct StoreState {
    conn: Connection,
    history_revision: u64,
}

/// One `chats` row. The wire sees a chat as `ChatState`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRecord {
    pub title: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub options: ChatOptions,
    /// The provider's own session, which the next turn resumes.
    pub session: Option<ProviderSession>,
    pub entry_count: u32,
}

/// `config_dir` is the one the session was made under. The CLI keeps its transcript there, so a
/// changed directory cannot resume it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSession {
    pub provider: ProviderKind,
    pub id: String,
    pub config_dir: String,
}

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
        conn.create_scalar_function("history_lower", 1, FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC, |ctx| {
            Ok(ctx.get::<Option<String>>(0)?.map(|text| text.to_lowercase()))
        })?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            let tx = conn.unchecked_transaction()?;
            tx.execute_batch(sql)?;
            if i == 3 {
                let mut stmt = tx.prepare("SELECT id, sql FROM history")?;
                let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
                for row in rows {
                    let (id, sql) = row?;
                    tx.execute(
                        "UPDATE history SET is_write = ?1 WHERE id = ?2",
                        params![crate::sql::history_is_write(&sql), id],
                    )?;
                }
            }
            tx.pragma_update(None, "user_version", (i + 1) as i64)?;
            tx.commit()?;
        }
        Ok(Self { state: Mutex::new(StoreState { conn, history_revision: 0 }) })
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T, StoreError>) -> Result<T, StoreError> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        f(&state.conn)
    }

    pub(crate) fn with_history<T>(&self, f: impl FnOnce(&Connection, &mut u64) -> Result<T, StoreError>) -> Result<T, StoreError> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let StoreState { conn, history_revision } = &mut *state;
        f(conn, history_revision)
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
            let tx = c.unchecked_transaction()?;
            tx.execute("DELETE FROM connections WHERE id = ?1", [id.0.to_string()])?;
            tx.execute("DELETE FROM secrets WHERE connection_id = ?1", [id.0.to_string()])?;
            tx.execute("DELETE FROM connection_views WHERE connection_id = ?1", [id.0.to_string()])?;
            tx.commit()?;
            Ok(())
        })
    }

    /// The connection's stored view. A row that fails to parse reads as `None`, which the caller
    /// takes as the initial view: a bad row can hide the tree's extras, never the connection.
    pub fn view(&self, id: ConnectionId) -> Result<Option<ConnectionView>, StoreError> {
        self.with(|c| {
            let json: Option<String> =
                c.query_row("SELECT json FROM connection_views WHERE connection_id = ?1", [id.0.to_string()], |r| r.get(0)).optional()?;
            Ok(json.and_then(|j| match serde_json::from_str(&j) {
                Ok(view) => Some(view),
                Err(e) => {
                    eprintln!("connection view {} unreadable, using the initial view: {e}", id.0);
                    None
                }
            }))
        })
    }

    pub fn set_view(&self, id: ConnectionId, view: &ConnectionView) -> Result<(), StoreError> {
        self.with(|c| {
            c.execute(
                "INSERT INTO connection_views (connection_id, json) VALUES (?1, ?2) ON CONFLICT (connection_id) DO UPDATE SET json = excluded.json",
                params![id.0.to_string(), serde_json::to_string(view)?],
            )?;
            Ok(())
        })
    }

    pub fn secret(&self, id: ConnectionId) -> Result<Option<Sealed>, StoreError> {
        self.with(|c| {
            Ok(c.query_row("SELECT nonce, ciphertext FROM secrets WHERE connection_id = ?1", [id.0.to_string()], |r| {
                Ok(Sealed { nonce: r.get(0)?, ciphertext: r.get(1)? })
            })
            .optional()?)
        })
    }

    pub fn set_secret(&self, id: ConnectionId, sealed: &Sealed) -> Result<(), StoreError> {
        self.with(|c| {
            c.execute(
                "INSERT INTO secrets (connection_id, nonce, ciphertext) VALUES (?1, ?2, ?3)
                 ON CONFLICT (connection_id) DO UPDATE SET nonce = excluded.nonce, ciphertext = excluded.ciphertext",
                params![id.0.to_string(), sealed.nonce, sealed.ciphertext],
            )?;
            Ok(())
        })
    }

    pub fn delete_secret(&self, id: ConnectionId) -> Result<(), StoreError> {
        self.with(|c| {
            c.execute("DELETE FROM secrets WHERE connection_id = ?1", [id.0.to_string()])?;
            Ok(())
        })
    }

    pub fn insert_history_and_prune(&self, h: HistoryInsert) -> Result<HistoryEntry, StoreError> {
        self.with_history(|conn, revision| {
            let tx = conn.unchecked_transaction()?;
            let c = &tx;
            c.execute(
                "INSERT INTO history (at_ms, connection_id, connection_name, database, sql, elapsed_ms, outcome_json, is_write)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    h.at_ms,
                    h.connection_id.0.to_string(),
                    h.connection_name,
                    h.database,
                    h.sql,
                    h.elapsed_ms,
                    serde_json::to_string(&h.outcome)?,
                    crate::sql::history_is_write(&h.sql)
                ],
            )?;
            let id = c.last_insert_rowid();
            c.execute(
                "DELETE FROM history WHERE id <= (SELECT id FROM history ORDER BY id DESC LIMIT 1 OFFSET ?1)",
                [HISTORY_KEEP],
            )?;
            tx.commit()?;
            *revision += 1;
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
        self.with_history(|c, revision| {
            c.execute("DELETE FROM history", [])?;
            *revision += 1;
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

impl Store {
    const PUT_ENTRY: &str = "INSERT INTO chat_entries (chat_id, seq, turn, json) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (chat_id, seq) DO UPDATE SET turn = excluded.turn, json = excluded.json";

    /// The newest `limit` chats. A row that fails to parse is logged and left out, so it never
    /// hides the others.
    pub fn chats(&self, limit: u32) -> Result<Vec<(ChatId, ChatRecord)>, StoreError> {
        self.with(|c| {
            let mut stmt = c.prepare("SELECT id, json FROM chats ORDER BY updated_ms DESC, id LIMIT ?1")?;
            let rows = stmt.query_map([limit], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            let mut chats = Vec::new();
            for row in rows {
                let (id, json) = row?;
                match (id.parse(), serde_json::from_str(&json)) {
                    (Ok(uuid), Ok(record)) => chats.push((ChatId(uuid), record)),
                    (Err(e), _) => eprintln!("chat {id} has a bad id, left out of the list: {e}"),
                    (_, Err(e)) => eprintln!("chat {id} unreadable, left out of the list: {e}"),
                }
            }
            Ok(chats)
        })
    }

    pub fn chat(&self, id: ChatId) -> Result<Option<ChatRecord>, StoreError> {
        self.with(|c| {
            let json: Option<String> = c.query_row("SELECT json FROM chats WHERE id = ?1", [id.0.to_string()], |r| r.get(0)).optional()?;
            Ok(json.map(|j| serde_json::from_str(&j)).transpose()?)
        })
    }

    /// `(seq, turn, entry)` in seq order. A row this build cannot parse reads as `Entry::Unreadable`,
    /// so the chat still opens.
    pub fn chat_entries(&self, id: ChatId) -> Result<Vec<(u32, u32, Entry)>, StoreError> {
        self.with(|c| {
            let mut stmt = c.prepare("SELECT seq, turn, json FROM chat_entries WHERE chat_id = ?1 ORDER BY seq")?;
            let rows = stmt.query_map([id.0.to_string()], |r| Ok((r.get::<_, u32>(0)?, r.get::<_, u32>(1)?, r.get::<_, String>(2)?)))?;
            rows.map(|row| {
                let (seq, turn, json) = row?;
                let entry = serde_json::from_str(&json).unwrap_or_else(|e| {
                    eprintln!("chat {} entry {seq} unreadable: {e}", id.0);
                    Entry::Unreadable
                });
                Ok((seq, turn, entry))
            })
            .collect()
        })
    }

    pub fn put_chat(&self, id: ChatId, record: &ChatRecord) -> Result<(), StoreError> {
        self.with(|c| {
            c.execute(
                "INSERT INTO chats (id, updated_ms, json) VALUES (?1, ?2, ?3)
                 ON CONFLICT (id) DO UPDATE SET updated_ms = excluded.updated_ms, json = excluded.json",
                params![id.0.to_string(), record.updated_at_ms, serde_json::to_string(record)?],
            )?;
            Ok(())
        })
    }

    pub fn put_entry(&self, id: ChatId, seq: u32, turn: u32, entry: &Entry) -> Result<(), StoreError> {
        self.with(|c| {
            c.execute(Self::PUT_ENTRY, params![id.0.to_string(), seq, turn, serde_json::to_string(entry)?])?;
            Ok(())
        })
    }

    pub fn put_entries(&self, id: ChatId, rows: &[(u32, u32, Entry)]) -> Result<(), StoreError> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            for (seq, turn, entry) in rows {
                tx.execute(Self::PUT_ENTRY, params![id.0.to_string(), seq, turn, serde_json::to_string(entry)?])?;
            }
            tx.commit()?;
            Ok(())
        })
    }

    /// The chat's entries go with it, by the foreign key's cascade.
    pub fn delete_chat(&self, id: ChatId) -> Result<(), StoreError> {
        self.with(|c| {
            c.execute("DELETE FROM chats WHERE id = ?1", [id.0.to_string()])?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{EffortId, ModelId, Permission, Settings, SslMode, TurnOutcome};

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
            user: "l1data".into(),
            ssl_mode: SslMode::Prefer,
            ca_cert_path: None,
            has_password: true,
            color: None,
        };
        {
            let s = Store::open(&path).unwrap();
            s.upsert_connection(&config).unwrap();
            s.kv_set("settings", &Settings { max_rows: 7, ..Settings::default() }).unwrap();
            s.insert_history_and_prune(entry("select 1")).unwrap();
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
    fn a_view_is_stored_per_connection_and_a_bad_row_reads_as_none() {
        use crate::view::{DatabaseView, Selection};
        let (s, _dir) = store();
        let id = ConnectionId(uuid::Uuid::new_v4());
        assert_eq!(s.view(id).unwrap(), None);

        let mut view = ConnectionView::initial();
        view.databases = Selection::Only { names: ["reporting".to_owned()].into() };
        view.schemas.insert("reporting".into(), DatabaseView { schemas: Selection::All, show_system_schemas: true });
        s.set_view(id, &view).unwrap();
        assert_eq!(s.view(id).unwrap(), Some(view.clone()));
        view.show_system_databases = true;
        s.set_view(id, &view).unwrap();
        assert_eq!(s.view(id).unwrap(), Some(view));

        s.with(|c| {
            c.execute("UPDATE connection_views SET json = '{\"databases\": 7' WHERE connection_id = ?1", [id.0.to_string()])?;
            Ok(())
        })
        .unwrap();
        assert_eq!(s.view(id).unwrap(), None);

        s.set_view(id, &ConnectionView::initial()).unwrap();
        s.delete_connection(id).unwrap();
        assert_eq!(s.view(id).unwrap(), None, "the view row goes with the connection");
    }

    #[test]
    fn history_pages_newest_first_and_filters() {
        let (s, _dir) = store();
        for i in 0..5 {
            s.insert_history_and_prune(entry(&format!("select {i}"))).unwrap();
        }
        let other = HistoryInsert { connection_id: ConnectionId(uuid::Uuid::new_v4()), ..entry("select other") };
        let other_id = other.connection_id;
        s.insert_history_and_prune(other).unwrap();

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
            s.insert_history_and_prune(entry(&format!("q{i}"))).unwrap();
        }
        let count: i64 = s.with(|c| Ok(c.query_row("SELECT count(*) FROM history", [], |r| r.get(0))?)).unwrap();
        assert_eq!(count, HISTORY_KEEP);
        let all = s.history(&HistoryQuery { text: None, connection_id: None, before_id: None, limit: u16::MAX }).unwrap();
        assert_eq!(all.entries.last().unwrap().sql, "q5", "the five oldest rows are gone");
    }

    fn chat_id(n: u128) -> ChatId {
        ChatId(uuid::Uuid::from_u128(n))
    }

    fn record(title: &str, updated_at_ms: i64) -> ChatRecord {
        ChatRecord {
            title: title.into(),
            created_at_ms: 1,
            updated_at_ms,
            options: ChatOptions { provider: ProviderKind::Claude, model: ModelId("opus".into()), effort: Some(EffortId("high".into())), permission: Permission::AskFirst },
            session: None,
            entry_count: 0,
        }
    }

    fn user(text: &str) -> Entry {
        Entry::User { at_ms: 5, text: text.into(), context: None, attachment: None }
    }

    fn entry_count(s: &Store) -> i64 {
        s.with(|c| Ok(c.query_row("SELECT count(*) FROM chat_entries", [], |r| r.get(0))?)).unwrap()
    }

    #[test]
    fn migration_5_adds_the_chat_tables_to_a_version_4_store_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.sqlite3");
        {
            let c = Connection::open(&path).unwrap();
            for sql in &MIGRATIONS[..4] {
                c.execute_batch(sql).unwrap();
            }
            c.pragma_update(None, "user_version", 4).unwrap();
            c.execute("INSERT INTO kv (key, json) VALUES ('workspace', '{}')", []).unwrap();
        }
        let first = record("first", 10);
        Store::open(&path).unwrap().put_chat(chat_id(1), &first).unwrap();
        let s = Store::open(&path).unwrap();
        let version: i64 = s.with(|c| Ok(c.query_row("PRAGMA user_version", [], |r| r.get(0))?)).unwrap();
        assert_eq!(version, 5);
        assert_eq!(s.chats(10).unwrap(), vec![(chat_id(1), first)]);
        assert_eq!(s.kv_get::<serde_json::Value>("workspace").unwrap(), Some(serde_json::json!({})));
    }

    #[test]
    fn chats_and_entries_round_trip_newest_first() {
        let (s, _dir) = store();
        let (old, new) = (chat_id(1), chat_id(2));
        s.put_chat(old, &record("old", 10)).unwrap();
        s.put_chat(new, &record("new", 20)).unwrap();
        assert_eq!(s.chats(10).unwrap(), vec![(new, record("new", 20)), (old, record("old", 10))]);
        assert_eq!(s.chats(1).unwrap(), vec![(new, record("new", 20))]);

        let resumed = ChatRecord {
            session: Some(ProviderSession { provider: ProviderKind::Claude, id: "4f1c".into(), config_dir: "~/.claude".into() }),
            entry_count: 3,
            ..record("old", 30)
        };
        s.put_chat(old, &resumed).unwrap();
        assert_eq!(s.chats(10).unwrap(), vec![(old, resumed.clone()), (new, record("new", 20))]);
        assert_eq!(s.chat(old).unwrap(), Some(resumed));
        assert_eq!(s.chat(chat_id(9)).unwrap(), None);

        let done = Entry::End { at_ms: 9, outcome: TurnOutcome::Completed, suggestions: vec!["Show totals".into()] };
        s.put_entries(old, &[(2, 0, Entry::Text { blocks: vec![], done: false }), (0, 0, user("hi")), (1, 0, Entry::Notice { text: "restarted".into() })]).unwrap();
        s.put_entry(old, 2, 0, &done).unwrap();
        s.put_entry(new, 0, 0, &user("other chat")).unwrap();
        assert_eq!(s.chat_entries(old).unwrap(), vec![(0, 0, user("hi")), (1, 0, Entry::Notice { text: "restarted".into() }), (2, 0, done)]);
        assert!(s.put_entry(chat_id(9), 0, 0, &user("orphan")).is_err(), "an entry needs its chat row");
    }

    #[test]
    fn an_unreadable_row_never_hides_the_rest() {
        let (s, _dir) = store();
        let (good, bad) = (chat_id(1), chat_id(2));
        s.put_chat(good, &record("good", 10)).unwrap();
        s.put_chat(bad, &record("bad", 20)).unwrap();
        s.put_entries(good, &[(0, 0, user("hi")), (1, 0, user("again"))]).unwrap();
        s.with(|c| {
            c.execute("UPDATE chat_entries SET json = '{\"kind\": \"Hologram\"}' WHERE seq = 0", [])?;
            c.execute("UPDATE chats SET json = '{\"title\": 7}' WHERE id = ?1", [bad.0.to_string()])?;
            Ok(())
        })
        .unwrap();
        assert_eq!(s.chat_entries(good).unwrap(), vec![(0, 0, Entry::Unreadable), (1, 0, user("again"))]);
        assert_eq!(s.chats(10).unwrap(), vec![(good, record("good", 10))]);
    }

    #[test]
    fn deleting_a_chat_deletes_its_entries_only() {
        let (s, _dir) = store();
        let (gone, kept) = (chat_id(1), chat_id(2));
        s.put_chat(gone, &record("gone", 10)).unwrap();
        s.put_chat(kept, &record("kept", 20)).unwrap();
        s.put_entries(gone, &[(0, 0, user("a")), (1, 0, user("b"))]).unwrap();
        s.put_entry(kept, 0, 0, &user("c")).unwrap();
        assert_eq!(entry_count(&s), 3);

        s.delete_chat(gone).unwrap();
        assert_eq!(entry_count(&s), 1);
        assert_eq!(s.chat(gone).unwrap(), None);
        assert_eq!(s.chat_entries(kept).unwrap(), vec![(0, 0, user("c"))]);
        assert_eq!(s.chats(10).unwrap(), vec![(kept, record("kept", 20))]);
    }
}

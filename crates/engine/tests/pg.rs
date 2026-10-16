#![cfg(feature = "pg-tests")]

use std::sync::Arc;
use std::time::{Duration, Instant};

use engine::model::*;
use engine::{AgentPath, Engine, EngineConfig, MemoryKeyStore, draft_from_url};
use futures_util::TryStreamExt;
use tokio::sync::broadcast;
use tokio_postgres::NoTls;

const DEFAULT_URL: &str = "postgres://l1data:l1data@localhost:5433/shop";
const MOCKUP_QUERY: &str = "select c.region, count(*) as orders, sum(o.total) as revenue
from orders o join customers c on c.id = o.customer_id
where o.status = 'paid' and o.created_at > now() - interval '90 days'
group by c.region order by revenue desc";

fn log_line(body: &OutputBody) -> String {
    match body {
        OutputBody::Statement { statement, text } => format!("{statement}> {text}"),
        OutputBody::Rows { statement, rows, truncated, .. } => format!("{statement} rows {rows}{}", if *truncated { " truncated" } else { "" }),
        OutputBody::Command { statement, tag, .. } => format!("{statement} {tag}"),
        OutputBody::Notice { severity, message, .. } => format!("{severity}: {message}"),
        OutputBody::Error { statement, error } => format!("{statement:?} ERROR: {}", error.message),
        OutputBody::Info { message } => message.clone(),
    }
}

fn url() -> String {
    std::env::var("L1_DATA_TEST_PG").unwrap_or_else(|_| DEFAULT_URL.into())
}

struct Harness {
    engine: Arc<Engine>,
    events: broadcast::Receiver<AppEvent>,
    seen: Vec<AppEvent>,
    conn: ConnectionId,
    database: String,
    dir: tempfile::TempDir,
}

impl Harness {
    async fn start() -> Self {
        Self::start_in(tempfile::tempdir().unwrap()).await
    }

    async fn start_in(dir: tempfile::TempDir) -> Self {
        Self::start_with(dir, draft_from_url(&url(), "dev").unwrap()).await
    }

    /// A fresh engine whose one connection logs in as `role`, so `pg_stat_activity` can tell
    /// this test's backends from those of the tests running beside it.
    async fn start_as(role: &Role) -> Self {
        let draft = ConnectionDraft { user: role.name.clone(), password: PasswordInput::Set(ROLE_PASSWORD.into()), ..draft_from_url(&url(), "dev").unwrap() };
        Self::start_with(tempfile::tempdir().unwrap(), draft).await
    }

    async fn start_with(dir: tempfile::TempDir, draft: ConnectionDraft) -> Self {
        let engine = Engine::open(EngineConfig { data_dir: dir.path().to_owned(), keys: Arc::new(MemoryKeyStore::default()), agent_path: AgentPath::Fixed("".into()) })
            .await
            .unwrap();
        let events = engine.subscribe();
        let existing = engine.boot().connections.into_iter().next();
        let config = match existing {
            Some(c) => c,
            None => engine.save_connection(draft).await.unwrap(),
        };
        Self { engine, events, seen: Vec::new(), conn: config.id, database: config.database, dir }
    }

    fn instance(&self) -> InstanceState {
        match self.status() {
            ConnStatus::Connected { instance, .. } => instance,
            other => panic!("{other:?}"),
        }
    }

    /// Names in the instance's `pg_database` list as the snapshot reports it.
    fn database_names(&self) -> Vec<String> {
        self.instance().databases.into_iter().map(|d| d.name).collect()
    }

    fn database_state(&self, name: &str) -> DatabaseState {
        self.instance().databases.into_iter().find(|d| d.name == name).unwrap_or_else(|| panic!("{name} not listed"))
    }

    async fn wait_database(&self, name: &str, done: impl Fn(&DatabaseState) -> bool) -> DatabaseState {
        let started = Instant::now();
        loop {
            let state = self.database_state(name);
            if done(&state) {
                return state;
            }
            assert!(started.elapsed() < Duration::from_secs(10), "{name} never reached the expected state: {state:?}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn edit_view(&self, edit: ViewEdit) {
        self.engine.edit_view(self.conn, edit).await.unwrap();
    }

    async fn wait_database_names(&self, done: impl Fn(&[String]) -> bool) -> Vec<String> {
        let started = Instant::now();
        loop {
            let names = self.database_names();
            if done(&names) {
                return names;
            }
            assert!(started.elapsed() < Duration::from_secs(10), "database list never reached the expected state: {names:?}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn status(&self) -> ConnStatus {
        self.engine.boot().live.into_iter().find(|c| c.id == self.conn).expect("connection entry").status
    }

    async fn wait_status(&self, done: impl Fn(&ConnStatus) -> bool) -> ConnStatus {
        let started = Instant::now();
        loop {
            let status = self.status();
            if done(&status) {
                return status;
            }
            assert!(started.elapsed() < Duration::from_secs(10), "connection never reached the expected status: {status:?}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// The connection's configured database, the one every tab targets unless told otherwise.
    fn db(&self) -> DatabaseRef {
        self.db_named(&self.database)
    }

    fn db_named(&self, database: &str) -> DatabaseRef {
        DatabaseRef { connection_id: self.conn, database: database.to_owned() }
    }

    async fn sql_tab(&self, mode: TxnMode) -> TabId {
        self.sql_tab_in(mode, None).await
    }

    async fn sql_tab_in(&self, mode: TxnMode, schema: Option<&str>) -> TabId {
        self.configure(mode, &self.database, schema).await
    }

    async fn sql_tab_on(&self, mode: TxnMode, database: &str) -> TabId {
        self.configure(mode, database, None).await
    }

    async fn configure(&self, mode: TxnMode, database: &str, schema: Option<&str>) -> TabId {
        let tab = TabId(uuid::Uuid::new_v4());
        self.engine
            .console_configure(tab, ConsoleConfig { connection_id: self.conn, database: database.to_owned(), schema: schema.map(str::to_owned), mode })
            .await
            .unwrap();
        tab
    }

    /// The home database's catalog status as the connection snapshot reports it.
    fn catalog_status(&self, database: &str) -> CatalogStatus {
        let live = self.engine.boot().live;
        let ConnStatus::Connected { instance, .. } = &live[0].status else { panic!("{:?}", live[0].status) };
        instance.databases.iter().find(|d| d.name == database).unwrap_or_else(|| panic!("{database} not listed")).catalog.clone()
    }

    /// Waits until a connection snapshot has carried `version` for `database`, counting the
    /// snapshots already seen, since a refresh can publish before the run that caused it finishes.
    async fn wait_published(&mut self, database: &str, version: u64) {
        loop {
            self.drain();
            let published = self.seen.iter().any(|e| match e {
                AppEvent::ConnectionChanged(ConnectionState { id, status: ConnStatus::Connected { instance, .. }, .. }) if *id == self.conn => {
                    instance.databases.iter().any(|d| d.name == database && d.catalog == CatalogStatus::Ready { version })
                }
                _ => false,
            });
            if published {
                return;
            }
            self.next_event().await;
        }
    }

    /// Polls the catalog until `done` accepts it.
    async fn catalog_when(&self, db: &DatabaseRef, done: impl Fn(&Catalog) -> bool) -> Arc<Catalog> {
        let started = Instant::now();
        loop {
            if let Ok(catalog) = self.engine.catalog(db.clone()).await
                && done(&catalog)
            {
                return catalog;
            }
            assert!(started.elapsed() < Duration::from_secs(30), "catalog never reached the expected state");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn next_event(&mut self) -> AppEvent {
        let ev = tokio::time::timeout(Duration::from_secs(30), self.events.recv()).await.expect("event within 30s").unwrap();
        self.seen.push(ev.clone());
        ev
    }

    async fn wait_finished(&mut self, tab: TabId, run_id: RunId) -> ConsoleState {
        loop {
            if let AppEvent::ConsoleChanged(state) = self.next_event().await {
                if state.tab_id == tab && matches!(state.run, RunState::Finished { run_id: r, .. } if r == run_id) {
                    return state;
                }
            }
        }
    }

    async fn start_run(&mut self, tab: TabId, sql: &str) -> RunAccepted {
        self.engine
            .console_run(tab, RunRequest::Script { text: sql.into(), target: RunTarget::All })
            .await
            .unwrap()
    }

    async fn run(&mut self, tab: TabId, sql: &str) -> ConsoleState {
        let accepted = self.start_run(tab, sql).await;
        self.wait_finished(tab, accepted.run_id).await
    }

    async fn run_ok(&mut self, tab: TabId, sql: &str) -> ConsoleState {
        let state = self.run(tab, sql).await;
        assert!(matches!(state.run, RunState::Finished { outcome: RunOutcome::Ok, .. }), "{sql}: {:?}", state.run);
        state
    }

    fn result(state: &ConsoleState, index: usize) -> ResultMeta {
        match &state.run {
            RunState::Finished { statements, .. } => match &statements[index].status {
                StmtStatus::Rows { result, done: true } => result.clone(),
                other => panic!("statement {index} is not a finished result: {other:?}"),
            },
            other => panic!("not finished: {other:?}"),
        }
    }

    fn page(&self, meta: &ResultMeta, start: u32, len: u32) -> Vec<Vec<Option<String>>> {
        self.engine.result_page(meta.r#ref, start, len).unwrap().rows
    }

    async fn scalar(&mut self, tab: TabId, sql: &str) -> String {
        let state = self.run_ok(tab, sql).await;
        let meta = Self::result(&state, 0);
        self.page(&meta, 0, 1)[0][0].clone().expect("non-null scalar")
    }

    fn console(&self, tab: TabId) -> ConsoleState {
        self.engine.boot().consoles.into_iter().find(|c| c.tab_id == tab).expect("console")
    }

    fn entries(&self, tab: TabId) -> Vec<OutputEntry> {
        self.seen
            .iter()
            .filter_map(|e| match e {
                AppEvent::ConsoleOutput { tab_id, entries } if *tab_id == tab => Some(entries.iter().cloned()),
                _ => None,
            })
            .flatten()
            .collect()
    }

    fn outputs(&self, tab: TabId) -> Vec<OutputBody> {
        self.entries(tab).into_iter().map(|e| e.body).collect()
    }

    /// The tab's output log, one short string per entry, for literal assertions.
    fn log(&self, tab: TabId) -> Vec<String> {
        self.outputs(tab).iter().map(log_line).collect()
    }

    /// Collects events already sent, for calls such as `table_apply` that return without a run to wait on.
    fn drain(&mut self) {
        while let Ok(ev) = self.events.try_recv() {
            self.seen.push(ev);
        }
    }

    async fn oracle(&self) -> tokio_postgres::Client {
        let (client, connection) = tokio_postgres::connect(&url(), NoTls).await.unwrap();
        tokio::spawn(connection);
        let tz = iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".into());
        client.batch_execute(&format!("SET TimeZone = '{tz}'")).await.unwrap();
        client
    }
}

const ROLE_PASSWORD: &str = "pw";

/// A throwaway login role: every backend it owns on the server belongs to the test that made it.
struct Role {
    name: String,
    oracle: tokio_postgres::Client,
}

impl Role {
    async fn create() -> Self {
        let (oracle, connection) = tokio_postgres::connect(&url(), NoTls).await.unwrap();
        tokio::spawn(connection);
        let name = unique("t_role");
        oracle.batch_execute(&format!("create role {name} login password '{ROLE_PASSWORD}'")).await.unwrap();
        Self { name, oracle }
    }

    /// `(database, pid)` of every client backend logged in as the role, sorted.
    async fn backends(&self) -> Vec<(String, i32)> {
        let rows = self
            .oracle
            .query("select datname, pid from pg_stat_activity where usename = $1 and backend_type = 'client backend' order by datname, pid", &[&self.name])
            .await
            .unwrap();
        rows.iter().map(|r| (r.get::<_, String>(0), r.get::<_, i32>(1))).collect()
    }

    /// The backends once `done` accepts them, or whatever is left after five seconds: a closed
    /// socket reaches `pg_stat_activity` a little after the client drops it.
    async fn backends_when(&self, done: impl Fn(&[(String, i32)]) -> bool) -> Vec<(String, i32)> {
        let started = Instant::now();
        loop {
            let backends = self.backends().await;
            if done(&backends) || started.elapsed() > Duration::from_secs(5) {
                return backends;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    async fn drop(self) {
        self.oracle.batch_execute(&format!("drop role {}", self.name)).await.unwrap();
    }
}

fn statuses(state: &ConsoleState) -> Vec<&StmtStatus> {
    match &state.run {
        RunState::Finished { statements, .. } => statements.iter().map(|s| &s.status).collect(),
        other => panic!("not finished: {other:?}"),
    }
}

fn unique(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

#[tokio::test]
async fn connect_reports_server_and_catalog_has_the_mockup_tables() {
    let h = Harness::start().await;
    let server = h.engine.connect(h.conn).await.unwrap();
    assert!(server.version.starts_with("16."), "{}", server.version);
    assert!(server.version_num >= 160000);
    assert_eq!(server.encoding, "UTF8");
    assert_eq!(h.engine.connect(h.conn).await.unwrap().version, server.version, "connect is idempotent");

    let catalog = h.engine.catalog(h.db()).await.unwrap();
    assert_eq!(catalog.db.database, "shop");
    let names: Vec<&str> = catalog.schemas.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["information_schema", "lab", "pg_catalog", "public"]);
    let public = catalog.schemas.iter().find(|s| s.name == "public").unwrap();
    for (table, rows) in [("customers", 18_400), ("orders", 241_000), ("order_items", 612_000), ("payments", 238_000), ("products", 1_200)] {
        let rel = public.relations.iter().find(|r| r.name == table).unwrap_or_else(|| panic!("{table} missing"));
        assert_eq!(rel.kind, RelKind::Table);
        let estimate = rel.row_estimate.unwrap_or_else(|| panic!("{table} has no estimate"));
        assert!((estimate - rows).abs() * 20 < rows, "{table} estimate {estimate} vs {rows}");
        let id = &rel.columns[0];
        assert!(id.name == "id" && id.pk && id.not_null && id.type_display == "bigint", "{table}: {id:?}");
    }
    let views: Vec<&str> = public.relations.iter().filter(|r| r.kind == RelKind::View).map(|r| r.name.as_str()).collect();
    assert_eq!(views, ["low_stock", "paid_orders", "revenue_by_region"]);
    let slow = public.functions.iter().find(|f| f.name == "slow_echo").unwrap();
    assert_eq!((slow.args.as_str(), slow.returns.as_str(), slow.kind), ("secs double precision", "double precision", FnKind::Function));
    let zoo = catalog.relation("lab", "type_zoo").unwrap();
    assert_eq!(zoo.columns.iter().find(|c| c.name == "m").unwrap().type_display, "lab.mood");

    assert_eq!(h.catalog_status("shop"), CatalogStatus::Ready { version: 1 });
}

#[tokio::test]
async fn exact_row_count_is_exact_and_reports_missing_tables() {
    let h = Harness::start().await;
    assert!(matches!(h.engine.exact_row_count(h.db(), "public".into(), "coupons".into(), TableQuery::default()).await, Err(CountError::NotConnected)));
    h.engine.connect(h.conn).await.unwrap();
    assert_eq!(h.engine.exact_row_count(h.db(), "public".into(), "coupons".into(), TableQuery::default()).await.unwrap(), 3);
    assert_eq!(h.engine.exact_row_count(h.db(), "lab".into(), "type_zoo".into(), TableQuery::default()).await.unwrap(), 2);
    let missing = h.engine.exact_row_count(h.db(), "public".into(), "nope".into(), TableQuery::default()).await;
    assert!(matches!(&missing, Err(CountError::Failed { message }) if message.contains("does not exist")), "{missing:?}");
}

#[tokio::test]
async fn mockup_query_returns_six_regions_with_bigint_orders() {
    let mut h = Harness::start().await;
    let tab = h.sql_tab(TxnMode::AutoCommit).await;
    let state = h.run_ok(tab, MOCKUP_QUERY).await;
    let meta = Harness::result(&state, 0);
    assert_eq!(meta.row_count, 6);
    assert_eq!(meta.rows_seen, 6);
    assert!(meta.truncated.is_none());
    let cols: Vec<(&str, &str, TypeCategory)> =
        meta.columns.iter().map(|c| (c.name.as_str(), c.r#type.display.as_str(), c.r#type.category)).collect();
    assert_eq!(
        cols,
        [("region", "text", TypeCategory::Text), ("orders", "bigint", TypeCategory::Integer), ("revenue", "numeric", TypeCategory::Numeric)]
    );
    assert_eq!(meta.columns[0].source.map(|s| s.attnum), Some(4), "region is customers.region");
    let rows = h.page(&meta, 0, 10);
    assert_eq!(rows.len(), 6);
    let regions: Vec<&str> = rows.iter().map(|r| r[0].as_deref().unwrap()).collect();
    assert_eq!(regions.len(), 6);
    assert!(regions.contains(&"EU-West") && regions.contains(&"APAC"));
    assert!(rows[0][2].as_deref().unwrap().contains('.'), "numeric text keeps its scale");
    assert!(matches!(h.engine.result_page(meta.r#ref, 7, 10), Err(ResultError::OutOfRange)));
    assert_eq!(h.log(tab), [format!("0> {MOCKUP_QUERY}"), "0 rows 6".into()]);
    assert!(matches!(state.session, SessionState::Open { backend_pid } if backend_pid > 0));
}

#[tokio::test]
async fn type_zoo_cells_equal_postgres_text_output() {
    let mut h = Harness::start().await;
    let tab = h.sql_tab(TxnMode::AutoCommit).await;
    let state = h.run_ok(tab, "select * from lab.type_zoo order by id").await;
    let meta = Harness::result(&state, 0);
    let rows = h.page(&meta, 0, 10);
    assert_eq!(rows.len(), 2);

    // The simple protocol on an independent session is Postgres's own text output per column
    // (what psql prints). `bool::text` would say `true` where the output function says `t`.
    let oracle = h.oracle().await;
    let expected = oracle.simple_query("select * from lab.type_zoo order by id").await.unwrap();
    let expected_rows: Vec<Vec<Option<String>>> = expected
        .iter()
        .filter_map(|m| match m {
            tokio_postgres::SimpleQueryMessage::Row(r) => Some((0..r.len()).map(|i| r.get(i).map(str::to_owned)).collect()),
            _ => None,
        })
        .collect();
    for (r, row) in rows.iter().enumerate() {
        for (c, col) in meta.columns.iter().enumerate() {
            assert_eq!(row[c], expected_rows[r][c], "row {r} column {} ({})", col.name, col.r#type.display);
        }
    }
    let by_name = |n: &str| meta.columns.iter().find(|c| c.name == n).unwrap().r#type.clone();
    assert_eq!((by_name("m").display.as_str(), by_name("m").category), ("lab.mood", TypeCategory::Enum));
    assert_eq!((by_name("arr_i").display.as_str(), by_name("arr_i").category), ("integer[]", TypeCategory::Array));
    assert_eq!(by_name("rng").category, TypeCategory::Range);
    assert_eq!(by_name("tstz").display, "timestamptz");
    assert_eq!(by_name("jb").category, TypeCategory::Json);
    assert_eq!(rows[0][1].as_deref(), Some("t"), "booleans render like psql");
    assert_eq!(rows[1][1], None);
    assert_eq!(rows[0][3].as_deref(), Some("9007199254740993"), "bigint beyond 2^53 is verbatim");
    assert_eq!(rows[1][7].as_deref(), Some(""), "empty string is not NULL");
}

#[tokio::test]
async fn multi_statement_run_tags_notices_and_history() {
    let mut h = Harness::start().await;
    let tab = h.sql_tab(TxnMode::AutoCommit).await;
    let script = "create temp table t_multi (id int, v text);\n\
                  insert into t_multi select g, 'v' || g from generate_series(1, 5) g;\n\
                  update t_multi set v = 'x' where id <= 3;\n\
                  select slow_echo(0.01);\n\
                  select count(*) from t_multi";
    let accepted = h.start_run(tab, script).await;
    assert_eq!(accepted.statements.len(), 5);
    let state = h.wait_finished(tab, accepted.run_id).await;
    let tags: Vec<String> = statuses(&state)
        .iter()
        .map(|s| match s {
            StmtStatus::Command { tag, .. } => tag.clone(),
            StmtStatus::Rows { result, .. } => format!("rows:{}", result.row_count),
            other => format!("{other:?}"),
        })
        .collect();
    assert_eq!(tags, ["CREATE TABLE", "INSERT 0 5", "UPDATE 3", "rows:1", "rows:1"]);
    assert_eq!(
        h.log(tab),
        [
            "0> create temp table t_multi (id int, v text)",
            "0 CREATE TABLE",
            "1> insert into t_multi select g, 'v' || g from generate_series(1, 5) g",
            "1 INSERT 0 5",
            "2> update t_multi set v = 'x' where id <= 3",
            "2 UPDATE 3",
            "3> select slow_echo(0.01)",
            "NOTICE: slept 0.01 seconds",
            "3 rows 1",
            "4> select count(*) from t_multi",
            "4 rows 1",
        ]
    );
    assert!(h.entries(tab).iter().all(|e| e.run_id == accepted.run_id));
    assert_eq!(h.scalar(tab, "select count(*) from t_multi where v = 'x'").await, "3", "temp table sticks to the tab's session");

    let history = h.engine.history(HistoryQuery { text: None, connection_id: Some(h.conn), before_id: None, limit: 10 });
    assert_eq!(history.entries.len(), 6);
    assert!(matches!(history.entries[0].outcome, HistoryOutcome::Rows { rows: 1 }));
    assert!(matches!(&history.entries[3].outcome, HistoryOutcome::Command { tag } if tag == "UPDATE 3"));
    assert_eq!(history.entries[5].sql, "create temp table t_multi (id int, v text)");
    assert!(h.seen.iter().filter(|e| matches!(e, AppEvent::HistoryAppended(_))).count() >= 6);
}

#[tokio::test]
async fn error_position_maps_to_utf16_past_an_emoji() {
    let mut h = Harness::start().await;
    let tab = h.sql_tab(TxnMode::AutoCommit).await;
    let text = "select 1;\nselect '😀 ok' as e, nope_column from customers limit 1";
    let cursor = text.encode_utf16().count() as u32 - 3;
    let accepted = h
        .engine
        .console_run(tab, RunRequest::Script { text: text.into(), target: RunTarget::Cursor { offset: DocOffset(cursor) } })
        .await
        .unwrap();
    assert_eq!(accepted.statements.len(), 1, "cursor picks only the second statement");
    let state = h.wait_finished(tab, accepted.run_id).await;
    let StmtStatus::Failed { error } = &statuses(&state)[0] else { panic!("{:?}", state.run) };
    assert_eq!(error.sqlstate.as_deref(), Some("42703"));
    let expected = text[..text.find("nope_column").unwrap()].encode_utf16().count() as u32;
    assert_eq!(error.position, Some(DocOffset(expected)));
    assert!(matches!(state.run, RunState::Finished { outcome: RunOutcome::Failed, .. }));
    assert_eq!(state.txn, TxnState::Idle);
    assert_eq!(h.log(tab), ["0> select '😀 ok' as e, nope_column from customers limit 1", "Some(0) ERROR: column \"nope_column\" does not exist"]);
}

#[tokio::test]
async fn cancel_finishes_cancelled_quickly() {
    let mut h = Harness::start().await;
    let tab = h.sql_tab(TxnMode::AutoCommit).await;
    let accepted = h.start_run(tab, "select slow_echo(30); select 2").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(matches!(h.engine.console_run(tab, RunRequest::Script { text: "select 1".into(), target: RunTarget::All }).await, Err(RunError::Busy)));
    assert!(matches!(h.engine.console_commit(tab).await, Err(TxnError::Busy)));
    let started = Instant::now();
    h.engine.console_cancel(tab).await;
    let state = h.wait_finished(tab, accepted.run_id).await;
    assert!(started.elapsed() < Duration::from_secs(2), "cancel took {:?}", started.elapsed());
    assert!(matches!(state.run, RunState::Finished { outcome: RunOutcome::Cancelled, .. }));
    assert!(matches!(statuses(&state)[..], [StmtStatus::Cancelled, StmtStatus::Skipped]));
    assert_eq!(h.log(tab), ["0> select slow_echo(30)", "Some(0) ERROR: canceling statement due to user request"]);
    assert_eq!(h.scalar(tab, "select 7").await, "7", "the session is usable afterwards");
    h.engine.console_cancel(tab).await;
}

#[tokio::test]
async fn manual_tab_isolated_until_commit_and_abort_rolls_back() {
    let mut h = Harness::start().await;
    let a = h.sql_tab(TxnMode::Manual).await;
    let b = h.sql_tab(TxnMode::AutoCommit).await;
    let table = unique("public.t_iso");
    h.run_ok(b, &format!("create table {table} (id int)")).await;

    let state = h.run_ok(a, &format!("insert into {table} values (1)")).await;
    assert_eq!(state.txn, TxnState::Active);
    assert_eq!(h.log(a), ["BEGIN (implicit)".into(), format!("0> insert into {table} values (1)"), "0 INSERT 0 1".into()]);
    assert_eq!(h.scalar(b, &format!("select count(*) from {table}")).await, "0");
    let err = h.engine.disconnect(h.conn, false).await.unwrap_err();
    assert!(matches!(err, DisconnectError::OpenTransactions { ref tabs } if tabs.len() == 1 && tabs[0].tab_id == a && tabs[0].has_writes));
    let reconfigure = |database: &str, mode| ConsoleConfig { connection_id: h.conn, database: database.into(), schema: None, mode };
    assert!(matches!(h.engine.console_configure(a, reconfigure("shop", TxnMode::AutoCommit)).await, Err(ConfigureError::TransactionOpen)));
    assert!(matches!(h.engine.console_configure(a, reconfigure("reporting", TxnMode::Manual)).await, Err(ConfigureError::TransactionOpen)));
    h.engine.console_commit(a).await.unwrap();
    assert_eq!(h.console(a).txn, TxnState::Idle);
    assert_eq!(h.scalar(b, &format!("select count(*) from {table}")).await, "1");
    assert!(matches!(h.engine.console_commit(a).await, Err(TxnError::NoTransaction)));

    let state = h.run(a, "select 1/0").await;
    assert!(matches!(state.run, RunState::Finished { outcome: RunOutcome::Failed, .. }));
    assert_eq!(state.txn, TxnState::Aborted);
    let state = h.run(a, "select 1").await;
    assert_eq!(state.txn, TxnState::Aborted, "an aborted block rejects everything but ROLLBACK");
    assert!(matches!(statuses(&state)[0], StmtStatus::Failed { error } if error.sqlstate.as_deref() == Some("25P02")));
    assert!(matches!(h.engine.console_commit(a).await, Err(TxnError::RolledBack)));
    assert_eq!(h.console(a).txn, TxnState::Idle);

    h.run_ok(a, &format!("insert into {table} values (2)")).await;
    h.engine.console_rollback(a).await.unwrap();
    assert_eq!(h.console(a).txn, TxnState::Idle);
    assert_eq!(h.scalar(b, &format!("select count(*) from {table}")).await, "1");

    h.run_ok(a, "begin; savepoint s; select 1; rollback to s; commit").await;
    assert_eq!(h.console(a).txn, TxnState::Idle);
    h.run_ok(b, &format!("drop table {table}")).await;
}

#[tokio::test]
async fn a_notice_raised_at_commit_carries_the_commit_run_id() {
    let mut h = Harness::start().await;
    let tab = h.sql_tab(TxnMode::Manual).await;
    let script = "create temp table t_deferred (id int);\n\
                  create function pg_temp.notice_deferred() returns trigger language plpgsql as $$ begin raise notice 'deferred'; return null; end $$;\n\
                  create constraint trigger t_deferred_notice after insert on t_deferred deferrable initially deferred for each row execute function pg_temp.notice_deferred();\n\
                  insert into t_deferred values (1)";
    let accepted = h.start_run(tab, script).await;
    let state = h.wait_finished(tab, accepted.run_id).await;
    assert!(matches!(state.run, RunState::Finished { outcome: RunOutcome::Ok, .. }), "{:?}", state.run);

    assert!(!h.log(tab).contains(&"NOTICE: deferred".to_owned()), "the trigger is deferred to COMMIT: {:?}", h.log(tab));

    let before = h.entries(tab).len();
    h.engine.console_commit(tab).await.unwrap();
    h.drain();
    let commit = &h.entries(tab)[before..];
    assert_eq!(commit.iter().map(|e| log_line(&e.body)).collect::<Vec<_>>(), ["0> COMMIT", "NOTICE: deferred", "0 COMMIT"]);
    assert!(commit.iter().all(|e| e.run_id == commit[0].run_id));
    assert!(commit[0].run_id > accepted.run_id, "commit run {:?} is not after run {:?}", commit[0].run_id, accepted.run_id);
}

#[tokio::test]
async fn a_long_statement_is_cut_to_two_thousand_chars_in_the_log() {
    let mut h = Harness::start().await;
    let tab = h.sql_tab(TxnMode::AutoCommit).await;
    let sql = format!("select '{}' as long", "é".repeat(2_500));
    h.run_ok(tab, &sql).await;
    let Some(OutputBody::Statement { statement: 0, text }) = h.outputs(tab).into_iter().next() else { panic!("{:?}", h.log(tab)) };
    let expected: String = sql.chars().take(2_000).chain(['…']).collect();
    assert_eq!(text, expected);
    assert_eq!(text.chars().count(), 2_001);
}

#[tokio::test]
async fn terminated_backend_becomes_lost_and_the_next_run_reopens() {
    let mut h = Harness::start().await;
    let tab = h.sql_tab(TxnMode::Manual).await;
    let state = h.run_ok(tab, "create temp table t_lost (id int)").await;
    let SessionState::Open { backend_pid } = state.session else { panic!("{:?}", state.session) };
    assert_eq!(state.txn, TxnState::Active);

    let oracle = h.oracle().await;
    oracle.simple_query(&format!("select pg_terminate_backend({backend_pid})")).await.unwrap();
    let state = h.run(tab, "select 1").await;
    assert!(matches!(state.session, SessionState::Lost { txn_lost: true, .. }), "{:?}", state.session);
    assert_eq!(state.txn, TxnState::Idle);
    assert!(h.outputs(tab).iter().any(|o| matches!(o, OutputBody::Info { message } if message.starts_with("Transaction rolled back"))));

    let state = h.run_ok(tab, "select 2").await;
    assert!(matches!(state.session, SessionState::Open { backend_pid: pid } if pid != backend_pid));
    let pid = match state.session {
        SessionState::Open { backend_pid } => backend_pid,
        _ => unreachable!(),
    };
    h.engine.console_rollback(tab).await.unwrap();

    oracle.simple_query(&format!("select pg_terminate_backend({pid})")).await.unwrap();
    let auto = h.sql_tab(TxnMode::AutoCommit).await;
    let state = h.run_ok(auto, "select 1").await;
    let SessionState::Open { backend_pid: auto_pid } = state.session else { panic!() };
    oracle.simple_query(&format!("select pg_terminate_backend({auto_pid})")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let state = h.run(auto, "select 3").await;
    assert!(matches!(state.session, SessionState::Lost { txn_lost: false, .. }), "{:?}", state.session);
    assert_eq!(h.scalar(auto, "select 4").await, "4", "an idle lost session is replaced transparently");
}

#[tokio::test]
async fn forced_disconnect_during_a_manual_run_leaves_the_tab_idle() {
    let mut h = Harness::start().await;
    let tab = h.sql_tab(TxnMode::Manual).await;
    let accepted = h.start_run(tab, "select pg_sleep(3)").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    h.engine.disconnect(h.conn, true).await.unwrap();
    let state = h.wait_finished(tab, accepted.run_id).await;
    assert!(matches!(state.run, RunState::Finished { outcome: RunOutcome::Cancelled, .. }), "{:?}", state.run);
    assert!(matches!(statuses(&state)[..], [StmtStatus::Cancelled]));
    assert!(matches!(state.session, SessionState::None), "{:?}", state.session);

    // The orphaned task sees its sleep cancelled now; it must not write that failure into the tab.
    tokio::time::sleep(Duration::from_millis(700)).await;
    let state = h.console(tab);
    assert_eq!(state.txn, TxnState::Idle, "the orphaned run wrote its transaction state");
    assert!(matches!(state.session, SessionState::None), "{:?}", state.session);

    let first = h.scalar(tab, "select pg_current_xact_id()::text").await;
    let second = h.scalar(tab, "select pg_current_xact_id()::text").await;
    assert_eq!(h.console(tab).txn, TxnState::Active, "manual mode opened a block again");
    assert_eq!(first, second, "both statements ran inside one transaction");
    assert!(h.log(tab).iter().any(|l| l == "BEGIN (implicit)"), "{:?}", h.log(tab));
    h.engine.console_rollback(tab).await.unwrap();
}

#[tokio::test]
async fn a_run_orphaned_by_disconnect_never_writes_into_the_next_run() {
    let mut h = Harness::start().await;
    let tab = h.sql_tab(TxnMode::AutoCommit).await;
    let survives_cancel = "select 1; select 2; do $$ begin perform pg_sleep(2); exception when query_canceled then perform pg_sleep(2); end $$";
    let old = h.start_run(tab, survives_cancel).await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    h.engine.disconnect(h.conn, true).await.unwrap();
    let new = h.start_run(tab, "select pg_sleep(3); select 'b1'; select 'b2'; select 'b3'").await;
    let state = h.wait_finished(tab, new.run_id).await;

    // The DO block outlives the cancel by two seconds, so the orphaned task ends during the new run.
    let runs: Vec<(RunId, bool)> = h
        .seen
        .iter()
        .filter_map(|e| match e {
            AppEvent::ConsoleChanged(s) if s.tab_id == tab => match &s.run {
                RunState::Running { run_id, .. } => Some((*run_id, false)),
                RunState::Finished { run_id, outcome, statements, .. } => {
                    Some((*run_id, *outcome == RunOutcome::Cancelled && statements.get(2).is_some_and(|s| matches!(s.status, StmtStatus::Cancelled))))
                }
                RunState::Idle => None,
            },
            _ => None,
        })
        .collect();
    let first_new = runs.iter().position(|(r, _)| *r == new.run_id).unwrap();
    let stale: Vec<RunId> = runs[first_new..].iter().map(|(r, _)| *r).filter(|r| *r != new.run_id).collect();
    assert!(stale.is_empty(), "stale run {stale:?} published after run {:?} was accepted", new.run_id);
    assert!(runs[..first_new].iter().any(|(r, cancelled)| *r == old.run_id && *cancelled), "disconnect finished the old run as Cancelled: {runs:?}");
    assert!(matches!(state.run, RunState::Finished { outcome: RunOutcome::Ok, .. }), "{:?}", state.run);
    assert_eq!(statuses(&state).len(), 4);
    assert!(statuses(&state).iter().all(|s| matches!(s, StmtStatus::Rows { done: true, .. })), "{:?}", state.run);
    assert_eq!(h.page(&Harness::result(&state, 3), 0, 1)[0][0].as_deref(), Some("b3"));
}

#[tokio::test]
async fn big_result_truncates_at_max_rows_and_keeps_counting() {
    let mut h = Harness::start().await;
    let tab = h.sql_tab(TxnMode::AutoCommit).await;
    let state = h.run_ok(tab, "select g, 'row ' || g from generate_series(1, 300000) g").await;
    let meta = Harness::result(&state, 0);
    assert_eq!(meta.row_count, 200_000);
    assert_eq!(meta.rows_seen, 300_000);
    assert_eq!(meta.truncated, Some(TruncateReason::RowLimit));
    assert_eq!(h.page(&meta, 199_999, 5), vec![vec![Some("200000".to_owned()), Some("row 200000".to_owned())]]);
    let streaming = h
        .seen
        .iter()
        .filter(|e| matches!(e, AppEvent::ConsoleChanged(s) if s.tab_id == tab && matches!(s.run, RunState::Running { .. })))
        .count();
    assert!(streaming >= 2, "progress snapshots while streaming: {streaming}");
    assert_eq!(h.log(tab).last().map(String::as_str), Some("0 rows 300000 truncated"));
    assert_eq!(h.scalar(tab, "select 1").await, "1");
    assert!(matches!(h.engine.result_page(meta.r#ref, 0, 1), Err(ResultError::Gone)), "results die on re-run");
}

#[tokio::test]
async fn ddl_refreshes_the_catalog() {
    let mut h = Harness::start().await;
    let tab = h.sql_tab(TxnMode::AutoCommit).await;
    h.engine.connect(h.conn).await.unwrap();
    let table = unique("t_ddl");
    let initial = h.engine.catalog(h.db()).await.unwrap().version;
    h.run_ok(tab, &format!("create table public.{table} (id serial primary key, note text)")).await;
    let catalog = h.catalog_when(&h.db(), |c| c.version > initial).await;
    let version = catalog.version;
    assert_eq!(version, initial + 1, "one DDL statement causes one refresh");
    assert_eq!(catalog.relation("public", &table).unwrap().pk_columns(), ["id"]);
    h.wait_published("shop", version).await;
    assert_eq!(h.catalog_status("shop"), CatalogStatus::Ready { version });

    let page = h.engine.console_run(tab, RunRequest::TablePage { schema: "public".into(), table: "orders".into(), page: 2, query: TableQuery::default() }).await.unwrap();
    let state = h.wait_finished(tab, page.run_id).await;
    let meta = Harness::result(&state, 0);
    assert_eq!(meta.row_count, 500);
    let logged: Vec<String> = h.entries(tab).iter().filter(|e| e.run_id == page.run_id).map(|e| log_line(&e.body)).collect();
    assert_eq!(logged, ["0> SELECT * FROM \"public\".\"orders\" ORDER BY \"id\" LIMIT 500 OFFSET 1000", "0 rows 500"]);
    assert_eq!(h.page(&meta, 0, 1)[0][0].as_deref(), Some("1001"), "page 2 of 500 ordered by pk");

    h.run_ok(tab, &format!("drop table public.{table}")).await;
    let dropped = h.engine.refresh_catalog(h.db()).await.unwrap();
    assert!(dropped > version);
    assert!(h.engine.catalog(h.db()).await.unwrap().relation("public", &table).is_none());
}

#[tokio::test]
async fn csv_export_matches_copy_csv() {
    let mut h = Harness::start().await;
    let tab = h.sql_tab(TxnMode::AutoCommit).await;
    let sql = "select id, b, n, t, vc, jb, arr_t, m, tstz from lab.type_zoo order by id";
    let state = h.run_ok(tab, sql).await;
    let meta = Harness::result(&state, 0);
    let path = h.dir.path().join("zoo.csv");
    let summary = h.engine.export_csv(meta.r#ref, path.clone()).await.unwrap();
    let ours = std::fs::read_to_string(&path).unwrap();
    assert_eq!(summary.rows, 2);
    assert_eq!(summary.bytes, ours.len() as u64);
    assert!(!summary.truncated);

    let oracle = h.oracle().await;
    let stream = oracle.copy_out(&format!("copy ({sql}) to stdout with (format csv, header)")).await.unwrap();
    let chunks: Vec<bytes::Bytes> = stream.try_collect().await.unwrap();
    let theirs = String::from_utf8(chunks.concat()).unwrap();
    assert_eq!(ours.replace("\r\n", "\n"), theirs);
    assert!(matches!(h.engine.export_csv(ResultRef { index: 9, ..meta.r#ref }, path).await, Err(ExportError::Gone)));
}

#[tokio::test]
async fn history_survives_reopen_on_the_same_dir() {
    let dir = tempfile::tempdir().unwrap();
    let marker = unique("select 'hist");
    let sql = format!("{marker}'");
    {
        let mut h = Harness::start_in(dir).await;
        let tab = h.sql_tab(TxnMode::AutoCommit).await;
        h.run_ok(tab, &sql).await;
        let h2 = Harness::start_in(h.dir).await;
        let page = h2.engine.history(HistoryQuery { text: Some(marker.clone()), connection_id: None, before_id: None, limit: 5 });
        assert_eq!(page.entries.len(), 1);
        assert_eq!(page.entries[0].sql, sql);
        assert_eq!(page.entries[0].connection_name, "dev");
        assert_eq!(page.entries[0].database, "shop");
        assert!(h2.engine.boot().consoles.is_empty(), "consoles are not persisted");
        h2.engine.clear_history();
        assert!(h2.engine.history(HistoryQuery { text: None, connection_id: None, before_id: None, limit: 5 }).entries.is_empty());
    }
}

#[tokio::test]
async fn schema_and_search_path_follow_the_console_config() {
    let mut h = Harness::start().await;
    let tab = h.sql_tab_in(TxnMode::AutoCommit, Some("lab")).await;
    assert_eq!(h.scalar(tab, "select count(*) from type_zoo").await, "2");
    assert_eq!(h.scalar(tab, "show search_path").await, "lab");
    h.engine.console_configure(tab, ConsoleConfig { connection_id: h.conn, database: "shop".into(), schema: Some("public".into()), mode: TxnMode::AutoCommit }).await.unwrap();
    assert_eq!(h.scalar(tab, "show search_path").await, "public");
    assert_eq!(h.scalar(tab, "show application_name").await, "L1 Data");
    for copy in ["copy customers from stdin", "copy public.customers (id) to stdout", "copy pg_temp.nope from stdin with (format csv)"] {
        let err = h.engine.console_run(tab, RunRequest::Script { text: copy.into(), target: RunTarget::All }).await.err();
        assert!(matches!(err, Some(RunError::Unsupported { .. })), "{copy}: {err:?}");
    }
    assert_eq!(h.scalar(tab, "select 5").await, "5", "the session survived the rejected COPYs");
    assert!(matches!(h.engine.console_run(tab, RunRequest::Script { text: " -- nothing\n".into(), target: RunTarget::All }).await, Err(RunError::NoStatement)));
    h.engine.console_close(tab, false).await.unwrap();
    assert!(h.engine.boot().consoles.is_empty());
    h.engine.disconnect(h.conn, false).await.unwrap();
    assert!(matches!(h.engine.boot().live[0].status, ConnStatus::Disconnected));
    assert!(matches!(h.engine.catalog(h.db()).await, Err(CatalogError::NotConnected)));
}

#[tokio::test]
async fn bad_credentials_fail_with_auth_and_test_connection_works() {
    let h = Harness::start().await;
    let mut draft = draft_from_url(&url(), "x").unwrap();
    assert!(h.engine.test_connection(draft.clone()).await.unwrap().version.starts_with("16."));
    draft.password = PasswordInput::Set("wrong".into());
    assert!(matches!(h.engine.test_connection(draft.clone()).await, Err(ConnectError::Auth { .. })));
    draft.port = 1;
    assert!(matches!(h.engine.test_connection(draft).await, Err(ConnectError::Network { .. })));
}

fn cell(column: &str, value: Option<&str>) -> CellWrite {
    CellWrite { column: column.into(), value: value.map(Into::into) }
}

fn changes(table: &str) -> TableChanges {
    TableChanges { schema: "public".into(), table: table.into(), inserts: vec![], updates: vec![], deletes: vec![] }
}

async fn edit_table(h: &mut Harness, tab: TabId) -> String {
    let table = unique("t_edit");
    h.run_ok(tab, &format!("create table public.{table} (id serial primary key, name text not null, note text); insert into public.{table} (name) values ('a'), ('b'), ('c')")).await;
    h.engine.refresh_catalog(h.db()).await.unwrap();
    table
}

async fn rows_of(h: &mut Harness, tab: TabId, table: &str) -> String {
    h.scalar(tab, &format!("select coalesce(string_agg(id || ':' || name || ':' || coalesce(note, 'NULL'), ' ' order by id), '') from public.{table}")).await
}

#[tokio::test]
async fn table_apply_commits_every_change_or_none() {
    let mut h = Harness::start().await;
    h.engine.connect(h.conn).await.unwrap();
    let tab = h.sql_tab(TxnMode::AutoCommit).await;
    let table = edit_table(&mut h, tab).await;

    let mut ok = changes(&table);
    ok.deletes.push(vec![cell("id", Some("1"))]);
    ok.updates.push(RowUpdate { key: vec![cell("id", Some("2"))], set: vec![cell("name", Some("b'2")), cell("note", Some("x"))] });
    ok.inserts.push(vec![cell("name", Some("d"))]);
    let before = h.log(tab).len();
    let summary = h.engine.table_apply(tab, ok).await.unwrap();
    assert!(summary.committed);
    h.drain();
    assert_eq!(
        h.log(tab)[before..],
        [
            format!("0> DELETE FROM \"public\".\"{table}\" WHERE \"id\" = '1'"),
            "0 DELETE 1".into(),
            format!("1> UPDATE \"public\".\"{table}\" SET \"name\" = 'b''2', \"note\" = 'x' WHERE \"id\" = '2'"),
            "1 UPDATE 1".into(),
            format!("2> INSERT INTO \"public\".\"{table}\" (\"name\") VALUES ('d')"),
            "2 INSERT 0 1".into(),
        ]
    );
    assert_eq!(rows_of(&mut h, tab, &table).await, "2:b'2:x 3:c:NULL 4:d:NULL");
    assert_eq!(h.console(tab).txn, TxnState::Idle);

    let mut missing = changes(&table);
    missing.inserts.push(vec![cell("name", Some("e"))]);
    missing.updates.push(RowUpdate { key: vec![cell("id", Some("999"))], set: vec![cell("name", Some("ghost"))] });
    let err = h.engine.table_apply(tab, missing).await.unwrap_err();
    assert!(matches!(err, ApplyError::RowMismatch { change: ChangeRef { kind: ChangeKind::Update, index: 0 }, rows: 0 }), "{err:?}");

    let mut violating = changes(&table);
    violating.deletes.push(vec![cell("id", Some("3"))]);
    violating.inserts.push(vec![cell("note", Some("no name"))]);
    h.drain();
    let before = h.log(tab).len();
    let err = h.engine.table_apply(tab, violating).await.unwrap_err();
    assert!(matches!(&err, ApplyError::Failed { change: ChangeRef { kind: ChangeKind::Insert, index: 0 }, error } if error.sqlstate.as_deref() == Some("23502")), "{err:?}");
    h.drain();
    let failed = &h.log(tab)[before..];
    assert_eq!(failed.len(), 4, "{failed:?}");
    assert_eq!(failed[1], "0 DELETE 1");
    assert!(failed[3].starts_with("Some(1) ERROR: null value in column \"name\""), "{failed:?}");

    assert_eq!(rows_of(&mut h, tab, &table).await, "2:b'2:x 3:c:NULL 4:d:NULL", "failed applies left nothing behind");
    assert_eq!(h.console(tab).txn, TxnState::Idle);

    let mut keyless = changes(&table);
    keyless.deletes.push(vec![cell("name", Some("c"))]);
    assert!(matches!(h.engine.table_apply(tab, keyless).await, Err(ApplyError::NoPrimaryKey)));
    h.run_ok(tab, &format!("drop table public.{table}")).await;
}

#[tokio::test]
async fn table_apply_in_manual_mode_waits_for_commit_and_a_failure_keeps_the_open_transaction() {
    let mut h = Harness::start().await;
    h.engine.connect(h.conn).await.unwrap();
    let auto = h.sql_tab(TxnMode::AutoCommit).await;
    let table = edit_table(&mut h, auto).await;
    let manual = h.sql_tab(TxnMode::Manual).await;

    let mut insert = changes(&table);
    insert.inserts.push(vec![cell("name", Some("d"))]);
    let summary = h.engine.table_apply(manual, insert).await.unwrap();
    assert!(!summary.committed);
    assert_eq!(h.console(manual).txn, TxnState::Active);
    assert_eq!(rows_of(&mut h, auto, &table).await, "1:a:NULL 2:b:NULL 3:c:NULL", "other sessions don't see it before Commit");

    let mut failing = changes(&table);
    failing.updates.push(RowUpdate { key: vec![cell("id", Some("1"))], set: vec![cell("name", None)] });
    assert!(matches!(h.engine.table_apply(manual, failing).await, Err(ApplyError::Failed { .. })));
    assert_eq!(h.console(manual).txn, TxnState::Active, "the savepoint kept the transaction usable");
    assert_eq!(rows_of(&mut h, manual, &table).await, "1:a:NULL 2:b:NULL 3:c:NULL 4:d:NULL", "earlier work in the transaction survives");

    h.engine.console_commit(manual).await.unwrap();
    assert_eq!(rows_of(&mut h, auto, &table).await, "1:a:NULL 2:b:NULL 3:c:NULL 4:d:NULL");
    h.run_ok(auto, &format!("drop table public.{table}")).await;
}

#[tokio::test]
async fn table_pages_sort_and_filter_in_the_engine() {
    let mut h = Harness::start().await;
    h.engine.connect(h.conn).await.unwrap();
    let tab = h.sql_tab(TxnMode::AutoCommit).await;
    let query = TableQuery {
        order_by: r#""created_at" DESC"#.into(),
        filters: vec![ColumnFilter { column: "email".into(), op: FilterOp::StartsWith, value: "user1".into() }],
        r#where: "region = 'APAC'".into(),
    };
    let page = h
        .engine
        .console_run(tab, RunRequest::TablePage { schema: "public".into(), table: "customers".into(), page: 0, query: query.clone() })
        .await
        .unwrap();
    let state = h.wait_finished(tab, page.run_id).await;
    let meta = Harness::result(&state, 0);
    let rows = h.page(&meta, 0, meta.row_count);
    let expected = h
        .scalar(tab, "select count(*) from customers where region = 'APAC' and email ilike 'user1%'")
        .await
        .parse::<u32>()
        .unwrap();
    assert_eq!(meta.row_count, expected.min(500));
    assert!(rows.iter().all(|r| r[3].as_deref() == Some("APAC") && r[1].as_deref().unwrap().starts_with("user1")));
    let created: Vec<&str> = rows.iter().map(|r| r[4].as_deref().unwrap()).collect();
    assert!(created.windows(2).all(|w| w[0] >= w[1]), "newest first");
    assert_eq!(h.engine.exact_row_count(h.db(), "public".into(), "customers".into(), query).await.unwrap(), u64::from(expected));

    for smuggled in [
        TableQuery { r#where: "true; drop table customers".into(), ..Default::default() },
        TableQuery { order_by: "id; drop table customers".into(), ..Default::default() },
    ] {
        let refused = h.engine.console_run(tab, RunRequest::TablePage { schema: "public".into(), table: "customers".into(), page: 0, query: smuggled }).await;
        assert!(matches!(refused, Err(RunError::BadFilter)), "{refused:?}");
    }
}

#[tokio::test]
async fn sql_comments_in_where_and_order_by_keep_the_page_limit() {
    let mut h = Harness::start().await;
    h.engine.connect(h.conn).await.unwrap();
    let tab = h.sql_tab(TxnMode::AutoCommit).await;
    let query = TableQuery { order_by: "id DESC -- newest first".into(), filters: vec![], r#where: "region = 'APAC' -- only asia".into() };
    let page = h
        .engine
        .console_run(tab, RunRequest::TablePage { schema: "public".into(), table: "customers".into(), page: 0, query: query.clone() })
        .await
        .unwrap();
    let state = h.wait_finished(tab, page.run_id).await;
    let meta = Harness::result(&state, 0);
    assert_eq!(meta.row_count, 500, "the comment must not swallow LIMIT");
    let apac = h.scalar(tab, "select count(*) from customers where region = 'APAC'").await.parse::<u64>().unwrap();
    assert_eq!(h.engine.exact_row_count(h.db(), "public".into(), "customers".into(), query).await.unwrap(), apac);
}

#[tokio::test]
async fn table_page_on_second_database_uses_its_pk() {
    let mut h = Harness::start().await;
    let tab = h.sql_tab_on(TxnMode::AutoCommit, "reporting").await;
    let page = h
        .engine
        .console_run(tab, RunRequest::TablePage { schema: "public".into(), table: "daily".into(), page: 0, query: TableQuery::default() })
        .await
        .unwrap();
    let state = h.wait_finished(tab, page.run_id).await;
    assert_eq!(Harness::result(&state, 0).row_count, 90);
    let logged: Vec<String> = h.entries(tab).iter().filter(|e| e.run_id == page.run_id).map(|e| log_line(&e.body)).collect();
    assert_eq!(logged, ["0> SELECT * FROM \"public\".\"daily\" ORDER BY \"day\" LIMIT 500 OFFSET 0", "0 rows 90"]);
    assert_eq!(h.scalar(tab, "select current_database()").await, "reporting");

    let reporting = h.engine.catalog(h.db_named("reporting")).await.unwrap();
    assert_eq!(reporting.db, h.db_named("reporting"));
    assert_eq!(reporting.schemas.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["audit", "information_schema", "pg_catalog", "public"]);
    assert_eq!(reporting.relation("public", "daily").unwrap().pk_columns(), ["day"]);
    assert!(h.engine.catalog(h.db()).await.unwrap().relation("public", "daily").is_none(), "shop's catalog is a different database");

    let mut changes = TableChanges { schema: "public".into(), table: "daily".into(), inserts: vec![], updates: vec![], deletes: vec![] };
    changes.updates.push(RowUpdate { key: vec![cell("day", Some("2026-01-02"))], set: vec![cell("orders", Some("101"))] });
    assert!(h.engine.table_apply(tab, changes).await.unwrap().committed, "the full key of daily is its own primary key");
    h.run_ok(tab, "update daily set orders = 101 where day = '2026-01-02'").await;
}

#[tokio::test]
async fn catalog_versions_rise_across_reconnect() {
    let h = Harness::start().await;
    h.engine.connect(h.conn).await.unwrap();
    let started = Instant::now();
    while h.catalog_status("shop") != (CatalogStatus::Ready { version: 1 }) {
        assert!(started.elapsed() < Duration::from_secs(10), "connect loads the home catalog by itself: {:?}", h.catalog_status("shop"));
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(h.engine.catalog(h.db()).await.unwrap().version, 1);
    assert_eq!(h.engine.refresh_catalog(h.db()).await.unwrap(), 2);
    h.engine.disconnect(h.conn, false).await.unwrap();
    assert!(matches!(h.engine.catalog(h.db()).await, Err(CatalogError::NotConnected)));
    h.engine.connect(h.conn).await.unwrap();
    assert_eq!(h.engine.catalog(h.db()).await.unwrap().version, 3, "a reconnect never reissues a version the UI has seen");
    assert_eq!(h.catalog_status("shop"), CatalogStatus::Ready { version: 3 });
}

#[tokio::test]
async fn ddl_burst_coalesces_refreshes() {
    let mut h = Harness::start().await;
    h.engine.connect(h.conn).await.unwrap();
    let tab = h.sql_tab(TxnMode::AutoCommit).await;
    let gate = unique("t_gate");
    h.run_ok(tab, &format!("create table public.{gate} (id int); insert into public.{gate} values (1)")).await;
    let before = h.catalog_when(&h.db(), |c| c.relation("public", &gate).is_some()).await.version;

    // A count holds the metadata session, so every refresh the burst schedules queues behind it.
    let (engine, db, held) = (h.engine.clone(), h.db(), gate.clone());
    let slow = tokio::spawn(async move {
        let query = TableQuery { r#where: "pg_sleep(3)::text = ''".into(), ..Default::default() };
        engine.exact_row_count(db, "public".into(), held, query).await
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    let tables: Vec<String> = (0..30).map(|i| format!("{}_{i}", unique("t_burst"))).collect();
    let script = tables.iter().map(|t| format!("create table public.{t} (id int)")).collect::<Vec<_>>().join(";\n");
    h.run_ok(tab, &script).await;
    assert_eq!(slow.await.unwrap().unwrap(), 1);

    h.catalog_when(&h.db(), |c| tables.iter().all(|t| c.relation("public", t).is_some())).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let settled = h.engine.catalog(h.db()).await.unwrap().version;
    assert_eq!(settled - before, 2, "30 DDL statements caused exactly two loads");
    let drops = tables.iter().chain([&gate]).map(|t| format!("drop table public.{t}")).collect::<Vec<_>>().join(";\n");
    h.run_ok(tab, &drops).await;
}

#[tokio::test]
async fn history_records_console_database() {
    let mut h = Harness::start().await;
    let shop = h.sql_tab(TxnMode::AutoCommit).await;
    let reporting = h.sql_tab_on(TxnMode::AutoCommit, "reporting").await;
    let marker = unique("select 'db");
    h.run_ok(shop, &format!("{marker}'")).await;
    h.run_ok(reporting, &format!("{marker}'")).await;
    let page = h.engine.history(HistoryQuery { text: Some(marker), connection_id: Some(h.conn), before_id: None, limit: 10 });
    let databases: Vec<&str> = page.entries.iter().map(|e| e.database.as_str()).collect();
    assert_eq!(databases, ["reporting", "shop"], "newest first, each with the database its console ran in");
}

#[tokio::test]
async fn a_database_no_tab_or_tree_uses_gets_no_catalog() {
    let h = Harness::start().await;
    h.engine.connect(h.conn).await.unwrap();
    let postgres = h.db_named("postgres");
    assert!(matches!(h.engine.catalog(postgres.clone()).await, Err(CatalogError::NotShown { ref database }) if database == "postgres"));
    assert!(matches!(h.engine.catalog(h.db_named("nope")).await, Err(CatalogError::UnknownDatabase { ref database }) if database == "nope"));
    assert_eq!(h.catalog_status("postgres"), CatalogStatus::Idle);

    let tab = h.sql_tab_on(TxnMode::AutoCommit, "postgres").await;
    let catalog = h.engine.catalog(postgres.clone()).await.unwrap();
    assert_eq!(catalog.schemas.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["information_schema", "pg_catalog", "public"]);
    assert!(matches!(h.catalog_status("postgres"), CatalogStatus::Ready { .. }));

    h.engine.console_close(tab, false).await.unwrap();
    assert!(matches!(h.engine.catalog(postgres).await, Err(CatalogError::NotShown { .. })), "closing the console closes its slot");
    assert_eq!(h.catalog_status("postgres"), CatalogStatus::Idle);

    let live = h.engine.boot().live;
    let ConnStatus::Connected { instance, .. } = &live[0].status else { panic!("{:?}", live[0].status) };
    assert_eq!(instance.home, "shop");
    // Databases other tests create and drop while this one runs are not part of the seed.
    let rows: Vec<(&str, bool, DbAccess, bool)> =
        instance.databases.iter().filter(|d| !d.name.starts_with("t_db_")).map(|d| (d.name.as_str(), d.system, d.access, d.shown)).collect();
    assert_eq!(
        rows,
        [
            ("postgres", false, DbAccess::Ok, false),
            ("reporting", false, DbAccess::Ok, false),
            ("shop", false, DbAccess::Ok, true),
            ("template0", true, DbAccess::NoConnections, false),
            ("template1", true, DbAccess::Ok, false),
        ]
    );
}

/// Connect, use a second database from a console, then disconnect: home metadata, `reporting`
/// metadata, and the console session must all be gone from the server.
#[tokio::test]
async fn disconnect_closes_every_metadata_session() {
    let role = Role::create().await;
    let mut h = Harness::start_as(&role).await;
    let tab = h.sql_tab_on(TxnMode::AutoCommit, "reporting").await;
    h.run_ok(tab, "select 1").await;
    h.catalog_when(&h.db_named("reporting"), |_| true).await;
    let open: Vec<String> = role.backends().await.into_iter().map(|(db, _)| db).collect();
    assert_eq!(open, ["reporting", "reporting", "shop"], "metadata on shop and reporting, plus the console on reporting");

    h.engine.disconnect(h.conn, false).await.unwrap();
    let left = role.backends_when(|b| b.is_empty()).await;
    assert_eq!(left, [], "a disconnect closes every session the instance opened");
    role.drop().await;
}

/// Losing the home session loses the instance, and the other databases' metadata sessions go
/// with it. The console's own session is not the instance's and stays.
#[tokio::test]
async fn a_lost_home_session_closes_the_other_metadata_sessions() {
    let role = Role::create().await;
    let mut h = Harness::start_as(&role).await;
    let tab = h.sql_tab_on(TxnMode::AutoCommit, "reporting").await;
    let state = h.run_ok(tab, "select 1").await;
    let SessionState::Open { backend_pid: console_pid } = state.session else { panic!("{:?}", state.session) };
    h.catalog_when(&h.db_named("reporting"), |_| true).await;
    let home: Vec<i32> = role.backends().await.into_iter().filter(|(db, _)| db == "shop").map(|(_, pid)| pid).collect();
    let [home_pid] = home[..] else { panic!("one home metadata session, found {home:?}") };

    role.oracle.simple_query(&format!("select pg_terminate_backend({home_pid})")).await.unwrap();
    let status = h.wait_status(|s| !matches!(s, ConnStatus::Connected { .. })).await;
    assert!(matches!(status, ConnStatus::Lost { .. }), "{status:?}");
    let left = role.backends_when(|b| b.len() == 1).await;
    assert_eq!(left, [("reporting".to_owned(), console_pid)], "only the console's session survives a loss");
    role.drop().await;
}

/// `ALTER DATABASE` inside a Manual-mode transaction is invisible to the home session until it
/// commits, so the list is re-read at commit, as the catalog is after transactional DDL.
#[tokio::test]
async fn alter_database_in_a_manual_transaction_refreshes_the_list_on_commit() {
    let mut h = Harness::start().await;
    let auto = h.sql_tab(TxnMode::AutoCommit).await;
    let (old, new) = (unique("t_db"), unique("t_db"));
    h.run_ok(auto, &format!("create database {old}")).await;
    h.wait_database_names(|names| names.contains(&old)).await;

    let manual = h.sql_tab(TxnMode::Manual).await;
    let state = h.run_ok(manual, &format!("alter database {old} rename to {new}")).await;
    assert_eq!(state.txn, TxnState::Active);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let names = h.database_names();
    assert!(names.contains(&old) && !names.contains(&new), "an uncommitted rename changes nothing: {names:?}");

    h.engine.console_commit(manual).await.unwrap();
    let names = h.wait_database_names(|names| names.contains(&new)).await;
    assert!(!names.contains(&old), "the committed rename replaced the old name: {names:?}");
    h.run_ok(auto, &format!("drop database {new}")).await;
    h.wait_database_names(|names| !names.contains(&new)).await;
}

/// A console-only database whose metadata session dies keeps its last catalog on the wire, and
/// the next `catalog()` reopens the session and reloads.
#[tokio::test]
async fn a_dead_metadata_session_keeps_the_last_catalog_until_the_next_load() {
    let role = Role::create().await;
    let mut h = Harness::start_as(&role).await;
    let tab = h.sql_tab_on(TxnMode::AutoCommit, "reporting").await;
    let state = h.run_ok(tab, "select 1").await;
    let SessionState::Open { backend_pid: console_pid } = state.session else { panic!("{:?}", state.session) };
    let reporting = h.db_named("reporting");
    let before_catalog = h.catalog_when(&reporting, |_| true).await;
    let before = before_catalog.version;
    let daily = before_catalog.relation("public", "daily").unwrap().oid;
    let meta: Vec<i32> = role.backends().await.into_iter().filter(|(db, pid)| db == "reporting" && *pid != console_pid).map(|(_, pid)| pid).collect();
    let [meta_pid] = meta[..] else { panic!("one reporting metadata session, found {meta:?}") };

    role.oracle.simple_query(&format!("select pg_terminate_backend({meta_pid})")).await.unwrap();
    let started = Instant::now();
    while !matches!(h.catalog_status("reporting"), CatalogStatus::Failed { .. }) {
        assert!(started.elapsed() < Duration::from_secs(10), "{:?}", h.catalog_status("reporting"));
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let CatalogStatus::Failed { version, message } = h.catalog_status("reporting") else { unreachable!() };
    assert_eq!(version, Some(before), "the last good version stays on the wire: {message}");
    assert!(matches!(h.status(), ConnStatus::Connected { .. }), "another database's session is not the home session");

    let detail = h.engine.relation_detail(reporting.clone(), daily).await.unwrap();
    assert_eq!(detail.catalog_version, before, "a detail read is not a catalog load");
    assert_eq!(h.catalog_status("reporting"), CatalogStatus::Failed { message, version: Some(before) });

    let reloaded = h.engine.catalog(reporting.clone()).await.unwrap();
    assert!(reloaded.version > before, "the next load reopened the session: {} > {before}", reloaded.version);
    assert_eq!(h.catalog_status("reporting"), CatalogStatus::Ready { version: reloaded.version });
    h.engine.disconnect(h.conn, false).await.unwrap();
    role.drop().await;
}

#[tokio::test]
async fn relation_detail_reads_orders() {
    let h = Harness::start().await;
    h.engine.connect(h.conn).await.unwrap();
    let catalog = h.engine.catalog(h.db()).await.unwrap();
    let orders = catalog.relation("public", "orders").unwrap();
    // By name: a dev database migrated in place has the same columns in another attnum order.
    let mut columns: Vec<(&str, TypeCategory, bool, bool)> = orders.columns.iter().map(|c| (c.name.as_str(), c.category, c.pk, c.fk)).collect();
    columns.sort_by_key(|c| c.0);
    assert_eq!(
        columns,
        [
            ("created_at", TypeCategory::Temporal, false, false),
            ("customer_id", TypeCategory::Integer, false, true),
            ("id", TypeCategory::Integer, true, false),
            ("metadata", TypeCategory::Json, false, false),
            ("number", TypeCategory::Text, false, false),
            ("ship_address_id", TypeCategory::Integer, false, true),
            ("status", TypeCategory::Text, false, false),
            ("total", TypeCategory::Numeric, false, false),
            ("updated_at", TypeCategory::Temporal, false, false),
        ]
    );
    let zoo = catalog.relation("lab", "type_zoo").unwrap();
    let category = |name: &str| zoo.columns.iter().find(|c| c.name == name).unwrap().category;
    assert_eq!(
        [category("m"), category("arr_i"), category("rng"), category("b")],
        [TypeCategory::Enum, TypeCategory::Array, TypeCategory::Range, TypeCategory::Bool]
    );

    let detail = h.engine.relation_detail(h.db(), orders.oid).await.unwrap();
    assert_eq!((detail.oid, detail.catalog_version), (orders.oid, catalog.version));
    let expr = |sql: &str| DefaultValue::Expr { sql: sql.into() };
    let mut defaults: Vec<(&str, DefaultValue)> = detail.defaults.iter().map(|d| (d.column.as_str(), d.value.clone())).collect();
    defaults.sort_by_key(|d| d.0);
    assert_eq!(
        defaults,
        [
            ("created_at", expr("now()")),
            ("id", DefaultValue::Identity { always: true }),
            ("metadata", expr("'{}'")),
            ("status", expr("'pending'")),
            ("updated_at", expr("now()")),
        ]
    );

    let names = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let foreign = |table: &str, cols: &[&str]| KeyKind::Foreign {
        ref_schema: "public".into(),
        ref_table: table.into(),
        ref_columns: names(cols),
        on_delete: FkAction::NoAction,
        on_update: FkAction::NoAction,
    };
    assert_eq!(
        detail.keys,
        [
            KeyInfo { name: "orders_pkey".into(), columns: names(&["id"]), kind: KeyKind::Primary },
            KeyInfo { name: "orders_customer_id_fkey".into(), columns: names(&["customer_id"]), kind: foreign("customers", &["id"]) },
            KeyInfo {
                name: "orders_customer_id_ship_address_id_fkey".into(),
                columns: names(&["customer_id", "ship_address_id"]),
                kind: foreign("addresses", &["customer_id", "id"]),
            },
            KeyInfo { name: "orders_number_key".into(), columns: names(&["number"]), kind: KeyKind::Unique },
        ]
    );

    let indexes: Vec<(&str, bool, bool, &str, Option<&str>)> =
        detail.indexes.iter().map(|i| (i.name.as_str(), i.unique, i.primary, i.keys.as_str(), i.predicate.as_deref())).collect();
    assert_eq!(
        indexes,
        [
            ("orders_pkey", true, true, "(id)", None),
            ("orders_number_key", true, false, "(number)", None),
            ("orders_created_at_idx", false, false, "(created_at DESC)", None),
            ("orders_customer_id_idx", false, false, "(customer_id)", None),
            ("orders_open_idx", false, false, "(status)", Some("status <> 'paid'::text")),
        ]
    );
    assert!(detail.indexes.iter().all(|i| i.method == "btree" && i.valid));

    let trigger = |name: &str, timing, events: &[TriggerEvent], function: &str| TriggerInfo {
        name: name.into(),
        timing,
        events: events.to_vec(),
        per_row: true,
        enabled: true,
        function: function.into(),
    };
    assert_eq!(
        detail.triggers,
        [
            trigger("orders_audit", TriggerTiming::After, &[TriggerEvent::Insert, TriggerEvent::Update, TriggerEvent::Delete], "audit_order"),
            trigger("orders_set_updated_at", TriggerTiming::Before, &[TriggerEvent::Update], "set_updated_at"),
        ]
    );

    assert!(matches!(h.engine.relation_detail(h.db(), 0).await, Err(DetailError::Gone)));
    assert!(matches!(
        h.engine.relation_detail(h.db_named("postgres"), orders.oid).await,
        Err(DetailError::Catalog { error: CatalogError::NotShown { .. } })
    ));
}

#[tokio::test]
async fn relation_detail_hides_partition_clones_and_shows_inherited_triggers() {
    let h = Harness::start().await;
    h.engine.connect(h.conn).await.unwrap();
    let (oracle, connection) = tokio_postgres::connect(&url(), NoTls).await.unwrap();
    tokio::spawn(connection);
    // A scratch schema would race the tests that count shop's schemas, so the tables share public.
    let s = unique("t_detail");
    oracle
        .batch_execute(&format!(
            "create table public.{s}_ptarget (id int, region text, primary key (id, region)) partition by list (region);
             create table public.{s}_ptarget_eu partition of public.{s}_ptarget for values in ('eu');
             create table public.{s}_ptarget_us partition of public.{s}_ptarget for values in ('us');
             create table public.{s}_t (a int, region text, constraint fk_part foreign key (a, region) references public.{s}_ptarget);
             create function public.{s}_noop() returns trigger language plpgsql as $$ begin return new; end $$;
             create trigger t_replica after insert on public.{s}_t for each row execute function public.{s}_noop();
             alter table public.{s}_t enable replica trigger t_replica;
             create table public.{s}_parted (id int) partition by range (id);
             create table public.{s}_parted_1 partition of public.{s}_parted for values from (0) to (10);
             create trigger t_parent after insert on public.{s}_parted for each row execute function public.{s}_noop();"
        ))
        .await
        .unwrap();
    let oid = async |table: &str| oracle.query_one(&format!("select 'public.{s}_{table}'::regclass::oid"), &[]).await.unwrap().get::<_, u32>(0);

    let t = h.engine.relation_detail(h.db(), oid("t").await).await.unwrap();
    let names = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(
        t.keys,
        [KeyInfo {
            name: "fk_part".into(),
            columns: names(&["a", "region"]),
            kind: KeyKind::Foreign {
                ref_schema: "public".into(),
                ref_table: format!("{s}_ptarget"),
                ref_columns: names(&["id", "region"]),
                on_delete: FkAction::NoAction,
                on_update: FkAction::NoAction,
            },
        }]
    );
    let trigger = |name: &str, enabled| TriggerInfo {
        name: name.into(),
        timing: TriggerTiming::After,
        events: vec![TriggerEvent::Insert],
        per_row: true,
        enabled,
        function: format!("{s}_noop"),
    };
    assert_eq!(t.triggers, [trigger("t_replica", false)], "a replica trigger does not fire in a normal session, and RI triggers stay hidden");

    let parted_1 = h.engine.relation_detail(h.db(), oid("parted_1").await).await.unwrap();
    assert_eq!(parted_1.triggers, [trigger("t_parent", true)], "a partition shows the row trigger it inherits");

    oracle.batch_execute(&format!("drop table public.{s}_t, public.{s}_ptarget, public.{s}_parted; drop function public.{s}_noop()")).await.unwrap();
}

/// What a connection with no stored view shows: the home database with every user schema, and
/// nothing else.
async fn assert_default_view(h: &Harness) {
    let shop = h.wait_database("shop", |d| matches!(d.catalog, CatalogStatus::Ready { .. })).await;
    assert!(shop.shown && !shop.show_system_schemas);
    assert_eq!(shop.shown_schemas, ["lab", "public"]);
    assert_eq!(shop.schema_count, SchemaCount::Known { count: 2 });
    assert_eq!(h.engine.catalog(h.db()).await.unwrap().default_schema.as_deref(), Some("public"));
    for name in ["postgres", "reporting"] {
        let d = h.database_state(name);
        assert!(!d.shown, "{name} is shown");
        assert_eq!((d.shown_schemas.len(), d.schema_count, d.catalog), (0, SchemaCount::Unknown, CatalogStatus::Idle), "{name}");
    }
    assert!(!h.instance().show_system_databases);
}

#[tokio::test]
async fn default_view_shows_home_with_all_its_schemas() {
    let h = Harness::start().await;
    h.engine.connect(h.conn).await.unwrap();
    assert_default_view(&h).await;
    let catalog = h.engine.catalog(h.db()).await.unwrap();
    let lab = catalog.schemas.iter().find(|s| s.name == "lab").unwrap();
    assert_eq!((lab.system, lab.table_count, lab.relations.len()), (false, 1, 1));
    let public = catalog.schemas.iter().find(|s| s.name == "public").unwrap();
    let tables = public.relations.iter().filter(|r| !matches!(r.kind, RelKind::View | RelKind::MaterializedView)).count();
    assert_eq!(public.table_count as usize, tables, "views are relations but not tables");
    assert!(public.relations.len() >= tables + 3, "the seed's three views are listed");
    let system: Vec<(&str, bool, usize, usize)> =
        catalog.schemas.iter().filter(|s| s.system).map(|s| (s.name.as_str(), s.table_count > 0, s.relations.len(), s.functions.len())).collect();
    assert_eq!(system, [("information_schema", true, 0, 0), ("pg_catalog", true, 0, 0)], "system schemas are listed with a count but not loaded");
}

#[tokio::test]
async fn showing_a_database_opens_its_slot_and_shows_only_its_default_schema() {
    let h = Harness::start().await;
    h.engine.connect(h.conn).await.unwrap();
    h.edit_view(ViewEdit::Database { name: "reporting".into(), shown: true }).await;
    let reporting = h.wait_database("reporting", |d| matches!(d.catalog, CatalogStatus::Ready { .. })).await;
    assert!(reporting.shown);
    assert_eq!(reporting.shown_schemas, ["public"]);
    assert_eq!(reporting.schema_count, SchemaCount::Known { count: 2 });
    assert!(h.database_state("shop").shown, "the home database stays shown");

    let catalog = h.engine.catalog(h.db_named("reporting")).await.unwrap();
    assert_eq!(catalog.default_schema.as_deref(), Some("public"));
    let schemas: Vec<(&str, bool, u32, usize)> = catalog.schemas.iter().map(|s| (s.name.as_str(), s.system, s.table_count, s.relations.len())).collect();
    assert_eq!(schemas, [("audit", false, 1, 1), ("information_schema", true, 4, 0), ("pg_catalog", true, 64, 0), ("public", false, 1, 1)]);

    h.edit_view(ViewEdit::Database { name: "reporting".into(), shown: true }).await;
    assert_eq!(h.database_state("reporting").shown_schemas, ["public"], "the same edit twice changes nothing");
}

#[tokio::test]
async fn hiding_a_database_closes_its_slot_unless_a_tab_uses_it() {
    let h = Harness::start().await;
    h.engine.connect(h.conn).await.unwrap();
    let reporting = h.db_named("reporting");
    h.edit_view(ViewEdit::Database { name: "reporting".into(), shown: true }).await;
    h.wait_database("reporting", |d| matches!(d.catalog, CatalogStatus::Ready { .. })).await;

    h.edit_view(ViewEdit::Database { name: "reporting".into(), shown: false }).await;
    let hidden = h.wait_database("reporting", |d| d.catalog == CatalogStatus::Idle).await;
    assert!(!hidden.shown && hidden.shown_schemas.is_empty());
    assert!(matches!(h.engine.catalog(reporting.clone()).await, Err(CatalogError::NotShown { .. })));

    let tab = h.sql_tab_on(TxnMode::AutoCommit, "reporting").await;
    assert_eq!(h.engine.catalog(reporting.clone()).await.unwrap().db, reporting);
    h.edit_view(ViewEdit::Database { name: "reporting".into(), shown: false }).await;
    let kept = h.database_state("reporting");
    assert!(matches!(kept.catalog, CatalogStatus::Ready { .. }), "{:?}", kept.catalog);
    assert!(!kept.shown);
    assert_eq!(h.engine.catalog(reporting).await.unwrap().relation("public", "daily").unwrap().pk_columns(), ["day"]);
    h.engine.console_close(tab, false).await.unwrap();
    h.wait_database("reporting", |d| d.catalog == CatalogStatus::Idle).await;
}

#[tokio::test]
async fn probe_counts_schemas_of_a_database_without_a_slot() {
    let role = Role::create().await;
    let h = Harness::start_as(&role).await;
    h.engine.connect(h.conn).await.unwrap();
    h.engine.probe_databases(h.conn, vec!["postgres".into(), "template0".into(), "nope".into()]);
    let probing = |d: &DatabaseState| d.schema_count != SchemaCount::Unknown && d.schema_count != SchemaCount::Probing;
    let postgres = h.wait_database("postgres", probing).await;
    assert_eq!((postgres.schema_count, postgres.catalog), (SchemaCount::Known { count: 1 }, CatalogStatus::Idle));
    let template0 = h.wait_database("template0", probing).await;
    assert!(
        matches!(&template0.schema_count, SchemaCount::Unavailable { message } if message.contains("is not currently accepting connections")),
        "{:?}",
        template0.schema_count
    );
    let left = role.backends_when(|b| b.iter().all(|(db, _)| db == "shop")).await;
    assert_eq!(left.iter().map(|(db, _)| db.as_str()).collect::<Vec<_>>(), ["shop"], "the probe session is gone; the home metadata session stays");
    h.engine.disconnect(h.conn, false).await.unwrap();
    role.drop().await;
}

#[tokio::test]
async fn showing_pg_catalog_loads_its_relations_and_no_functions() {
    let h = Harness::start().await;
    h.engine.connect(h.conn).await.unwrap();
    let initial = h.catalog_when(&h.db(), |_| true).await.version;
    h.edit_view(ViewEdit::ShowSystemSchemas { database: "shop".into(), show: true }).await;
    h.edit_view(ViewEdit::Schema { database: "shop".into(), name: "pg_catalog".into(), shown: true }).await;
    let loaded = h.catalog_when(&h.db(), |c| c.version > initial && c.schemas.iter().any(|s| s.name == "pg_catalog" && !s.relations.is_empty())).await;
    let pg_catalog = loaded.schemas.iter().find(|s| s.name == "pg_catalog").unwrap();
    assert!(pg_catalog.system && pg_catalog.relations.len() > 100 && pg_catalog.functions.is_empty(), "{} relations", pg_catalog.relations.len());
    let tables = pg_catalog.relations.iter().filter(|r| !matches!(r.kind, RelKind::View | RelKind::MaterializedView)).count();
    assert_eq!((pg_catalog.table_count, tables), (64, 64));
    let shop = h.wait_database("shop", |d| d.shown_schemas.iter().any(|s| s == "pg_catalog")).await;
    assert_eq!(shop.shown_schemas, ["lab", "pg_catalog", "public"]);
    assert!(shop.show_system_schemas);
    assert_eq!(shop.schema_count, SchemaCount::Known { count: 2 }, "the count stays non-system");

    h.edit_view(ViewEdit::ShowSystemSchemas { database: "shop".into(), show: false }).await;
    let off = h.wait_database("shop", |d| !d.show_system_schemas).await;
    assert_eq!(off.shown_schemas, ["lab", "public"]);
    h.catalog_when(&h.db(), |c| c.schemas.iter().any(|s| s.name == "pg_catalog" && s.relations.is_empty())).await;

    h.edit_view(ViewEdit::ShowSystemSchemas { database: "shop".into(), show: true }).await;
    let on = h.wait_database("shop", |d| d.shown_schemas.iter().any(|s| s == "pg_catalog")).await;
    assert_eq!(on.shown_schemas, ["lab", "pg_catalog", "public"], "the checked schema was remembered while the toggle was off");
}

#[tokio::test]
async fn a_view_row_that_fails_to_parse_falls_back_to_the_initial_view() {
    let (dir, conn) = {
        let h = Harness::start_in(tempfile::tempdir().unwrap()).await;
        h.engine.connect(h.conn).await.unwrap();
        h.edit_view(ViewEdit::Database { name: "reporting".into(), shown: true }).await;
        h.wait_database("reporting", |d| d.shown).await;
        h.engine.disconnect(h.conn, false).await.unwrap();
        let Harness { dir, conn, .. } = h;
        (dir, conn)
    };
    let sqlite = rusqlite::Connection::open(dir.path().join("l1-data.sqlite3")).unwrap();
    let changed = sqlite.execute("UPDATE connection_views SET json = '{\"databases\": [' WHERE connection_id = ?1", [conn.0.to_string()]).unwrap();
    assert_eq!(changed, 1, "the edit above stored a row");

    let h = Harness::start_in(dir).await;
    assert_eq!(h.conn, conn);
    // A fresh engine has a fresh in-memory vault, so the saved password has to be sealed again.
    h.engine.save_connection(ConnectionDraft { id: Some(conn), ..draft_from_url(&url(), "dev").unwrap() }).await.unwrap();
    h.engine.connect(h.conn).await.unwrap();
    assert_default_view(&h).await;
}

/// A role whose search path starts with `pg_catalog` still gets a user schema as its default:
/// "Default only" never shows a schema the picker hides.
#[tokio::test]
async fn a_search_path_starting_with_pg_catalog_defaults_to_a_user_schema() {
    let role = Role::create().await;
    role.oracle.batch_execute(&format!("alter role {} set search_path = pg_catalog, public", role.name)).await.unwrap();
    let mut h = Harness::start_as(&role).await;
    h.engine.connect(h.conn).await.unwrap();
    let tab = h.sql_tab(TxnMode::AutoCommit).await;
    assert_eq!(h.scalar(tab, "show search_path").await, "pg_catalog, public");
    let catalog = h.catalog_when(&h.db(), |_| true).await;
    assert_eq!(catalog.default_schema.as_deref(), Some("public"));
    h.engine.disconnect(h.conn, false).await.unwrap();
    role.drop().await;
}

/// The probe cache is a cache of the database list: a DDL re-read of `pg_database` drops it, so
/// a database dropped and recreated under its old name is counted again.
#[tokio::test]
async fn a_database_list_reread_drops_the_probe_cache() {
    let mut h = Harness::start().await;
    h.engine.connect(h.conn).await.unwrap();
    h.engine.probe_databases(h.conn, vec!["postgres".into()]);
    h.wait_database("postgres", |d| matches!(d.schema_count, SchemaCount::Known { .. })).await;
    let tab = h.sql_tab(TxnMode::AutoCommit).await;
    let name = unique("t_db");
    h.run_ok(tab, &format!("create database {name}")).await;
    h.wait_database_names(|names| names.contains(&name)).await;
    assert_eq!(h.database_state("postgres").schema_count, SchemaCount::Unknown, "the count went with the list it counted");
    h.run_ok(tab, &format!("drop database {name}")).await;
    h.wait_database_names(|names| !names.contains(&name)).await;
}

/// Showing a database whose stored selection is empty resets it to its default schema once the
/// catalog is known, unless the user chose the schemas in the meantime.
#[tokio::test]
async fn a_schema_choice_made_while_the_catalog_loads_is_not_reset() {
    let h = Harness::start().await;
    h.engine.connect(h.conn).await.unwrap();
    h.edit_view(ViewEdit::Schemas { database: "reporting".into(), preset: Preset::None }).await;
    h.edit_view(ViewEdit::Database { name: "reporting".into(), shown: true }).await;
    h.edit_view(ViewEdit::Schemas { database: "reporting".into(), preset: Preset::None }).await;
    let reporting = h.wait_database("reporting", |d| matches!(d.catalog, CatalogStatus::Ready { .. })).await;
    assert!(reporting.shown_schemas.is_empty(), "None was chosen on purpose: {:?}", reporting.shown_schemas);

    h.edit_view(ViewEdit::Database { name: "reporting".into(), shown: false }).await;
    h.wait_database("reporting", |d| d.catalog == CatalogStatus::Idle).await;
    h.edit_view(ViewEdit::Database { name: "reporting".into(), shown: true }).await;
    let reporting = h.wait_database("reporting", |d| matches!(d.catalog, CatalogStatus::Ready { .. }) && !d.shown_schemas.is_empty()).await;
    assert_eq!(reporting.shown_schemas, ["public"], "shown again with nothing else said, the empty selection resets to the default");
}

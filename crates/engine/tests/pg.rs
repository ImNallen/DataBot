//! Engine scenarios against the Docker Postgres (`pnpm db:up`). Run with `--features pg-tests`.
//! Nothing here writes to seed tables: writers create their own uniquely named tables.
#![cfg(feature = "pg-tests")]

use std::sync::Arc;
use std::time::{Duration, Instant};

use engine::model::*;
use engine::{Engine, EngineConfig, MemorySecrets, draft_from_url};
use futures_util::TryStreamExt;
use tokio::sync::broadcast;
use tokio_postgres::NoTls;

const DEFAULT_URL: &str = "postgres://databot:databot@localhost:5433/shop";
const MOCKUP_QUERY: &str = "select c.region, count(*) as orders, sum(o.total) as revenue
from orders o join customers c on c.id = o.customer_id
where o.status = 'paid' and o.created_at > now() - interval '90 days'
group by c.region order by revenue desc";

fn url() -> String {
    std::env::var("DATABOT_TEST_PG").unwrap_or_else(|_| DEFAULT_URL.into())
}

struct Harness {
    engine: Arc<Engine>,
    events: broadcast::Receiver<AppEvent>,
    /// Every event observed while waiting, for assertions on outputs and catalog changes.
    seen: Vec<AppEvent>,
    conn: ConnectionId,
    dir: tempfile::TempDir,
}

impl Harness {
    async fn start() -> Self {
        Self::start_in(tempfile::tempdir().unwrap()).await
    }

    async fn start_in(dir: tempfile::TempDir) -> Self {
        let engine = Engine::open(EngineConfig { data_dir: dir.path().to_owned(), secrets: Arc::new(MemorySecrets::default()) })
            .await
            .unwrap();
        let events = engine.subscribe();
        let existing = engine.boot().connections.into_iter().next();
        let conn = match existing {
            Some(c) => c.id,
            None => engine.save_connection(draft_from_url(&url(), "dev").unwrap()).await.unwrap().id,
        };
        Self { engine, events, seen: Vec::new(), conn, dir }
    }

    async fn sql_tab(&self, mode: TxnMode) -> TabId {
        self.sql_tab_in(mode, None).await
    }

    async fn sql_tab_in(&self, mode: TxnMode, schema: Option<&str>) -> TabId {
        let tab = TabId(uuid::Uuid::new_v4());
        self.engine
            .console_configure(tab, ConsoleConfig { connection_id: self.conn, schema: schema.map(str::to_owned), mode })
            .await
            .unwrap();
        tab
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

    fn outputs(&self, tab: TabId) -> Vec<OutputBody> {
        self.seen
            .iter()
            .filter_map(|e| match e {
                AppEvent::ConsoleOutput { tab_id, entries } if *tab_id == tab => Some(entries.iter().map(|e| e.body.clone())),
                _ => None,
            })
            .flatten()
            .collect()
    }

    async fn oracle(&self) -> tokio_postgres::Client {
        let (client, connection) = tokio_postgres::connect(&url(), NoTls).await.unwrap();
        tokio::spawn(connection);
        let tz = iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".into());
        client.batch_execute(&format!("SET TimeZone = '{tz}'")).await.unwrap();
        client
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

    let catalog = h.engine.catalog(h.conn).unwrap();
    assert_eq!(catalog.database, "shop");
    let names: Vec<&str> = catalog.schemas.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["lab", "public"]);
    let public = &catalog.schemas[1];
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

    let live = h.engine.boot().live;
    assert!(matches!(live[0].status, ConnStatus::Connected { catalog_version: 1, .. }));
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
        [("region", "text", TypeCategory::Text), ("orders", "bigint", TypeCategory::Numeric), ("revenue", "numeric", TypeCategory::Numeric)]
    );
    assert_eq!(meta.columns[0].source.map(|s| s.attnum), Some(4), "region is customers.region");
    let rows = h.page(&meta, 0, 10);
    assert_eq!(rows.len(), 6);
    let regions: Vec<&str> = rows.iter().map(|r| r[0].as_deref().unwrap()).collect();
    assert_eq!(regions.len(), 6);
    assert!(regions.contains(&"EU-West") && regions.contains(&"APAC"));
    assert!(rows[0][2].as_deref().unwrap().contains('.'), "numeric text keeps its scale");
    assert!(matches!(h.engine.result_page(meta.r#ref, 7, 10), Err(ResultError::OutOfRange)));
    assert!(matches!(h.outputs(tab).last(), Some(OutputBody::Rows { statement: 0, rows: 6, .. })));
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
    let outputs = h.outputs(tab);
    assert!(
        outputs.iter().any(|o| matches!(o, OutputBody::Notice { severity, message, .. } if severity == "NOTICE" && message == "slept 0.01 seconds")),
        "{outputs:?}"
    );
    assert!(outputs.iter().any(|o| matches!(o, OutputBody::Command { statement: 2, tag, .. } if tag == "UPDATE 3")));
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
    assert!(h.outputs(tab).iter().any(|o| matches!(o, OutputBody::Error { statement: Some(0), .. })));
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
    assert!(h.outputs(tab).iter().any(|o| matches!(o, OutputBody::Error { error, .. } if error.message.contains("canceling statement"))));
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
    assert!(h.outputs(a).iter().any(|o| matches!(o, OutputBody::Info { message } if message == "BEGIN (implicit)")));
    assert_eq!(h.scalar(b, &format!("select count(*) from {table}")).await, "0");
    let err = h.engine.disconnect(h.conn, false).await.unwrap_err();
    assert!(matches!(err, DisconnectError::OpenTransactions { ref tabs } if tabs.len() == 1 && tabs[0].tab_id == a && tabs[0].has_writes));
    assert!(matches!(h.engine.console_configure(a, ConsoleConfig { connection_id: h.conn, schema: None, mode: TxnMode::AutoCommit }).await, Err(ConfigureError::TransactionOpen)));
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
    assert!(h.outputs(tab).iter().any(|o| matches!(o, OutputBody::Info { message } if message == "BEGIN (implicit)")));
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
    assert!(matches!(h.outputs(tab).last(), Some(OutputBody::Rows { rows: 300_000, truncated: true, .. })));
    assert_eq!(h.scalar(tab, "select 1").await, "1");
    assert!(matches!(h.engine.result_page(meta.r#ref, 0, 1), Err(ResultError::Gone)), "results die on re-run");
}

#[tokio::test]
async fn ddl_refreshes_the_catalog() {
    let mut h = Harness::start().await;
    let tab = h.sql_tab(TxnMode::AutoCommit).await;
    h.engine.connect(h.conn).await.unwrap();
    let table = unique("t_ddl");
    h.run_ok(tab, &format!("create table public.{table} (id serial primary key, note text)")).await;
    let version = loop {
        if let AppEvent::CatalogChanged { connection_id, version } = h.next_event().await {
            if connection_id == h.conn && version > 1 {
                break version;
            }
        }
    };
    let catalog = h.engine.catalog(h.conn).unwrap();
    assert_eq!(catalog.version, version);
    let rel = catalog.relation("public", &table).expect("new table in catalog");
    assert_eq!(rel.pk_columns(), ["id"]);
    assert!(matches!(h.engine.boot().live[0].status, ConnStatus::Connected { catalog_version, .. } if catalog_version == version));

    let page = h.engine.console_run(tab, RunRequest::TablePage { schema: "public".into(), table: "orders".into(), page: 2 }).await.unwrap();
    let state = h.wait_finished(tab, page.run_id).await;
    let meta = Harness::result(&state, 0);
    assert_eq!(meta.row_count, 500);
    assert_eq!(h.page(&meta, 0, 1)[0][0].as_deref(), Some("1001"), "page 2 of 500 ordered by pk");

    h.run_ok(tab, &format!("drop table public.{table}")).await;
    let dropped = h.engine.refresh_catalog(h.conn).await.unwrap();
    assert!(dropped > version);
    assert!(h.engine.catalog(h.conn).unwrap().relation("public", &table).is_none());
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
    h.engine.console_configure(tab, ConsoleConfig { connection_id: h.conn, schema: Some("public".into()), mode: TxnMode::AutoCommit }).await.unwrap();
    assert_eq!(h.scalar(tab, "show search_path").await, "public");
    assert_eq!(h.scalar(tab, "show application_name").await, "DataBot");
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
    assert!(matches!(h.engine.catalog(h.conn), Err(NotConnected { .. })));
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

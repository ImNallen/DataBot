//! `Console`, its `SessionSlot`, and the run task that owns the session during a run.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use tokio::sync::Mutex;
use tokio_postgres::SimpleQueryMessage;
use tokio_postgres::error::DbError;

use crate::Shared;
use crate::connection::{original_position, query_error, transport_error};
use crate::model::*;
use crate::results::{Caps, ResultSet};
use crate::session::{CancelHandle, Session};
use crate::sql::{StmtKind, StmtSpan};
use crate::store::HistoryInsert;
use crate::text::{OffsetMap, synthesize_tag, type_ref};
use crate::txn::{StmtOutcome, needs_implicit_begin, txn_after};

/// Snapshots while rows stream are rate-limited to this interval per console.
const STREAM_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const QUERY_CANCELED: &str = "57014";

pub struct Console {
    pub tab: TabId,
    /// Held only for state edits, never across a query.
    pub inner: Mutex<ConsoleInner>,
    /// Results of the current or last run only; dropped on re-run. Read by sync `result_page`.
    pub results: std::sync::Mutex<Vec<Arc<ResultSet>>>,
    /// The last published state, for `boot()` without taking the async lock.
    pub latest: std::sync::Mutex<ConsoleState>,
    /// Set by `console_close`; a run that outlives its tab stops publishing.
    pub closed: AtomicBool,
}

pub struct ConsoleInner {
    pub config: ConsoleConfigView,
    pub session: SessionSlot,
    pub txn: TxnState,
    pub run: RunState,
    pub rev: u64,
    /// DDL ran inside an open transaction; the catalog refreshes once it commits.
    pub ddl_pending: bool,
}

pub enum SessionSlot {
    Empty,
    Idle(Session),
    /// The `Session` is owned by the run (or commit/rollback) task.
    InRun {
        run_id: RunId,
        backend_pid: i32,
        cancel: CancelHandle,
        stop: Arc<AtomicBool>,
    },
    Lost {
        reason: String,
        txn_lost: bool,
    },
}

impl Console {
    pub fn new(tab: TabId, config: ConsoleConfigView) -> Self {
        let inner = ConsoleInner {
            config,
            session: SessionSlot::Empty,
            txn: TxnState::Idle,
            run: RunState::Idle,
            rev: 0,
            ddl_pending: false,
        };
        let latest = ConsoleState {
            tab_id: tab,
            rev: 0,
            config: inner.config.clone(),
            session: SessionState::None,
            txn: TxnState::Idle,
            run: RunState::Idle,
        };
        Self {
            tab,
            inner: Mutex::new(inner),
            results: std::sync::Mutex::new(Vec::new()),
            latest: std::sync::Mutex::new(latest),
            closed: AtomicBool::new(false),
        }
    }

    pub fn result_set(&self, r: ResultRef) -> Option<Arc<ResultSet>> {
        self.results.lock().unwrap().iter().find(|s| s.r#ref == r).cloned()
    }

    pub fn snapshot(&self, inner: &ConsoleInner) -> ConsoleState {
        ConsoleState {
            tab_id: self.tab,
            rev: inner.rev,
            config: inner.config.clone(),
            session: match &inner.session {
                SessionSlot::Empty => SessionState::None,
                SessionSlot::Idle(s) => SessionState::Open { backend_pid: s.backend_pid },
                SessionSlot::InRun { backend_pid, .. } => SessionState::Open { backend_pid: *backend_pid },
                SessionSlot::Lost { reason, txn_lost } => SessionState::Lost { reason: reason.clone(), txn_lost: *txn_lost },
            },
            txn: inner.txn,
            run: inner.run.clone(),
        }
    }

    /// Bumps `rev` and emits the whole state.
    pub fn publish(&self, inner: &mut ConsoleInner, shared: &Shared) -> ConsoleState {
        inner.rev += 1;
        let state = self.snapshot(inner);
        *self.latest.lock().unwrap() = state.clone();
        if !self.closed.load(Ordering::Relaxed) {
            shared.emit(AppEvent::ConsoleChanged(state.clone()));
        }
        state
    }

    pub fn output(&self, shared: &Shared, run_id: Option<RunId>, body: OutputBody) {
        if self.closed.load(Ordering::Relaxed) {
            return;
        }
        shared.emit(AppEvent::ConsoleOutput {
            tab_id: self.tab,
            entries: vec![OutputEntry { at_ms: now_ms(), run_id, body }],
        });
    }

    /// Takes the idle session out for a run or a transaction command.
    pub fn take_session(&self, inner: &mut ConsoleInner, run_id: RunId) -> Option<(Session, Arc<AtomicBool>)> {
        let SessionSlot::Idle(_) = inner.session else { return None };
        let SessionSlot::Idle(session) = std::mem::replace(&mut inner.session, SessionSlot::Empty) else { unreachable!() };
        let stop = Arc::new(AtomicBool::new(false));
        inner.session = SessionSlot::InRun {
            run_id,
            backend_pid: session.backend_pid,
            cancel: session.cancel_handle(),
            stop: stop.clone(),
        };
        Some((session, stop))
    }

    /// Gives the session back after a run and applies the run's final `txn`. If the slot was
    /// reassigned meanwhile (disconnect or close) the session is dropped and the console stays Idle.
    pub fn return_session(&self, inner: &mut ConsoleInner, run_id: RunId, session: Session, txn: TxnState, lost: Option<String>) {
        if !matches!(inner.session, SessionSlot::InRun { run_id: r, .. } if r == run_id) {
            return;
        }
        inner.txn = txn;
        inner.session = match lost {
            Some(reason) => {
                let txn_lost = inner.txn != TxnState::Idle;
                inner.txn = TxnState::Idle;
                inner.ddl_pending = false;
                SessionSlot::Lost { reason, txn_lost }
            }
            None => SessionSlot::Idle(session),
        };
    }

    pub fn statements_mut(inner: &mut ConsoleInner) -> &mut Vec<StatementRun> {
        match &mut inner.run {
            RunState::Running { statements, .. } | RunState::Finished { statements, .. } => statements,
            RunState::Idle => unreachable!("run state is set before the run task starts"),
        }
    }
}

pub struct RunPlan {
    pub run_id: RunId,
    pub text: String,
    pub statements: Vec<PlannedStmt>,
    pub mode: TxnMode,
    pub schema: Option<String>,
    pub connection: ConnectionConfig,
}

pub struct PlannedStmt {
    pub span: StmtSpan,
    pub kind: StmtKind,
}

enum StmtOk {
    Rows(Arc<ResultSet>),
    Command { tag: String, elapsed_ms: u32 },
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

fn elapsed_ms(since: Instant) -> u32 {
    since.elapsed().as_millis().min(u32::MAX as u128) as u32
}

pub async fn run_task(console: Arc<Console>, shared: Arc<Shared>, mut session: Session, plan: RunPlan, stop: Arc<AtomicBool>) {
    let started = Instant::now();
    let run_id = plan.run_id;
    let map = OffsetMap::new(&plan.text);
    let (settings, mut txn) = {
        let inner = console.inner.lock().await;
        (shared.settings(), inner.txn)
    };
    let caps = Caps { max_rows: settings.max_rows, max_bytes: settings.max_result_bytes };
    let mut outcome = RunOutcome::Ok;
    let mut fatal = None;

    if session.schema != plan.schema {
        if let Err(e) = session.set_schema(plan.schema.as_deref()).await {
            let error = e.as_db_error().map_or_else(|| transport_error(&e), |db| query_error(db, None));
            console.output(&shared, Some(run_id), OutputBody::Error { statement: None, error });
        }
    }

    let mut index = 0;
    while index < plan.statements.len() {
        let stmt = &plan.statements[index];
        let i = index as u16;
        if stop.load(Ordering::Relaxed) {
            set_status(&console, &shared, i, StmtStatus::Cancelled).await;
            outcome = RunOutcome::Cancelled;
            break;
        }
        let sql = stmt.span.text(&plan.text);

        if needs_implicit_begin(plan.mode, txn, &stmt.kind) {
            match session.client.batch_execute("BEGIN").await {
                Ok(()) => {
                    txn = TxnState::Active;
                    console.output(&shared, Some(run_id), OutputBody::Info { message: "BEGIN (implicit)".into() });
                    let mut inner = console.inner.lock().await;
                    inner.txn = txn;
                    console.publish(&mut inner, &shared);
                }
                Err(e) => {
                    let error = e.as_db_error().map_or_else(|| transport_error(&e), |db| query_error(db, None));
                    console.output(&shared, Some(run_id), OutputBody::Error { statement: Some(i), error });
                    outcome = RunOutcome::Failed;
                    break;
                }
            }
        }

        set_status(&console, &shared, i, StmtStatus::Preparing).await;
        let result = match session.client.prepare(sql).await {
            Err(e) => Err(stmt_error(e, &map, &stmt.span)),
            Ok(prepared) if prepared.columns().is_empty() => {
                drop(prepared);
                run_command(&session, sql, &stmt.kind).await.map_err(|e| stmt_error(e, &map, &stmt.span))
            }
            Ok(prepared) => {
                let columns = prepared
                    .columns()
                    .iter()
                    .map(|c| ColumnMeta {
                        name: c.name().to_owned(),
                        r#type: type_ref(c.type_()),
                        source: c.table_oid().zip(c.column_id()).map(|(table_oid, attnum)| ColumnSource { table_oid, attnum }),
                    })
                    .collect();
                drop(prepared);
                let set = Arc::new(ResultSet::new(ResultRef { tab_id: console.tab, run_id, index: i }, columns));
                console.results.lock().unwrap().push(set.clone());
                set_status(&console, &shared, i, StmtStatus::Rows { result: set.meta(), done: false }).await;
                run_rows(&console, &shared, &mut session, sql, &set, &caps, i)
                    .await
                    .map_err(|e| stmt_error(e, &map, &stmt.span))
            }
        };
        publish_notices(&console, &shared, &mut session, run_id);

        let cancelled = stop.load(Ordering::Relaxed)
            && matches!(&result, Err(e) if e.sqlstate.as_deref() == Some(QUERY_CANCELED));
        if let Err(e) = &result {
            if e.severity == "FATAL" {
                fatal = Some(e.message.clone());
            }
        }
        txn = txn_after(txn, &stmt.kind, if result.is_ok() { StmtOutcome::Ok } else { StmtOutcome::Err });

        let (status, body, history) = match &result {
            Ok(StmtOk::Rows(set)) => {
                let meta = set.meta();
                (
                    StmtStatus::Rows { result: meta.clone(), done: true },
                    OutputBody::Rows { statement: i, rows: meta.rows_seen, elapsed_ms: meta.elapsed_ms, truncated: meta.truncated.is_some() },
                    (HistoryOutcome::Rows { rows: meta.rows_seen }, meta.elapsed_ms),
                )
            }
            Ok(StmtOk::Command { tag, elapsed_ms }) => (
                StmtStatus::Command { tag: tag.clone(), elapsed_ms: *elapsed_ms },
                OutputBody::Command { statement: i, tag: tag.clone(), elapsed_ms: *elapsed_ms },
                (HistoryOutcome::Command { tag: tag.clone() }, *elapsed_ms),
            ),
            Err(error) if cancelled => (
                StmtStatus::Cancelled,
                OutputBody::Error { statement: Some(i), error: error.clone() },
                (HistoryOutcome::Cancelled, 0),
            ),
            Err(error) => (
                StmtStatus::Failed { error: error.clone() },
                OutputBody::Error { statement: Some(i), error: error.clone() },
                (HistoryOutcome::Error { message: error.message.clone() }, 0),
            ),
        };
        {
            let mut inner = console.inner.lock().await;
            inner.txn = txn;
            Console::statements_mut(&mut inner)[index].status = status;
            if stmt.kind.is_ddl() && result.is_ok() {
                inner.ddl_pending = true;
            }
            if inner.ddl_pending && txn == TxnState::Idle {
                inner.ddl_pending = false;
                shared.schedule_catalog_refresh(plan.connection.id);
            }
            console.publish(&mut inner, &shared);
        }
        console.output(&shared, Some(run_id), body);
        shared.record_history(HistoryInsert {
            at_ms: now_ms(),
            connection_id: plan.connection.id,
            connection_name: plan.connection.name.clone(),
            database: plan.connection.database.clone(),
            sql: sql.to_owned(),
            elapsed_ms: history.1,
            outcome: history.0,
        });

        index += 1;
        if cancelled {
            outcome = RunOutcome::Cancelled;
            break;
        }
        if result.is_err() {
            outcome = RunOutcome::Failed;
            if settings.stop_on_error {
                break;
            }
        }
        if fatal.is_some() || session.closed_reason().is_some() {
            break;
        }
    }

    let lost = session.closed_reason_settled(fatal).await;
    let mut inner = console.inner.lock().await;
    let statements = Console::statements_mut(&mut inner);
    for s in statements.iter_mut().skip(index) {
        if matches!(s.status, StmtStatus::Pending) {
            s.status = StmtStatus::Skipped;
        }
    }
    let statements = statements.clone();
    console.return_session(&mut inner, run_id, session, txn, lost);
    if let SessionSlot::Lost { reason, txn_lost } = &inner.session {
        let message = if *txn_lost {
            format!("Transaction rolled back: connection lost ({reason})")
        } else {
            format!("Session reset: connection lost ({reason})")
        };
        console.output(&shared, Some(run_id), OutputBody::Info { message });
    }
    inner.run = RunState::Finished { run_id, elapsed_ms: elapsed_ms(started), statements, outcome };
    console.publish(&mut inner, &shared);
}

async fn set_status(console: &Console, shared: &Shared, index: u16, status: StmtStatus) {
    let mut inner = console.inner.lock().await;
    Console::statements_mut(&mut inner)[index as usize].status = status;
    console.publish(&mut inner, shared);
}

fn publish_notices(console: &Console, shared: &Shared, session: &mut Session, run_id: RunId) {
    for n in session.drain_notices() {
        console.output(shared, Some(run_id), notice_body(&n));
    }
}

pub fn notice_body(n: &DbError) -> OutputBody {
    OutputBody::Notice {
        severity: n.severity().to_owned(),
        message: n.message().to_owned(),
        detail: n.detail().map(str::to_owned),
    }
}

fn stmt_error(e: tokio_postgres::Error, map: &OffsetMap<'_>, span: &StmtSpan) -> QueryError {
    match e.as_db_error() {
        Some(db) => query_error(db, original_position(db).map(|n| map.pg_position(span, n))),
        None => transport_error(&e),
    }
}

async fn run_command(session: &Session, sql: &str, kind: &StmtKind) -> Result<StmtOk, tokio_postgres::Error> {
    let started = Instant::now();
    let messages = session.client.simple_query(sql).await?;
    let elapsed = elapsed_ms(started);
    let rows = messages
        .iter()
        .filter_map(|m| match m {
            SimpleQueryMessage::CommandComplete(n) => Some(*n),
            _ => None,
        })
        .last()
        .unwrap_or(0);
    Ok(StmtOk::Command { tag: synthesize_tag(kind, rows), elapsed_ms: elapsed })
}

/// Streams text rows into the arena, publishing growth at most every `STREAM_EMIT_INTERVAL`.
async fn run_rows(
    console: &Console,
    shared: &Shared,
    session: &mut Session,
    sql: &str,
    set: &Arc<ResultSet>,
    caps: &Caps,
    index: u16,
) -> Result<StmtOk, tokio_postgres::Error> {
    let ncols = set.columns.len();
    let started = Instant::now();
    let mut stream = std::pin::pin!(session.client.simple_query_raw(sql).await?);
    let mut last_emit = Instant::now();
    while let Some(message) = stream.next().await {
        if let SimpleQueryMessage::Row(row) = message? {
            set.push_row((0..ncols).map(|c| row.try_get(c).ok().flatten()), caps);
        }
        if last_emit.elapsed() >= STREAM_EMIT_INTERVAL {
            last_emit = Instant::now();
            set.set_elapsed(elapsed_ms(started));
            let mut inner = console.inner.lock().await;
            Console::statements_mut(&mut inner)[index as usize].status = StmtStatus::Rows { result: set.meta(), done: false };
            console.publish(&mut inner, shared);
            drop(inner);
            publish_notices(console, shared, session, set.r#ref.run_id);
        }
    }
    set.set_elapsed(elapsed_ms(started));
    Ok(StmtOk::Rows(set.clone()))
}

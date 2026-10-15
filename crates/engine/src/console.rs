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
use crate::sql::{Invalidates, StmtKind, StmtSpan};
use crate::store::HistoryInsert;
use crate::text::{OffsetMap, synthesize_tag, type_ref};
use crate::txn::{StmtOutcome, needs_implicit_begin, txn_after};

const STREAM_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const QUERY_CANCELED: &str = "57014";

pub struct Console {
    pub tab: TabId,
    pub inner: Mutex<ConsoleInner>,
    pub results: std::sync::Mutex<Vec<Arc<ResultSet>>>,
    pub latest: std::sync::Mutex<ConsoleState>,
    pub closed: AtomicBool,
}

pub struct ConsoleInner {
    pub config: ConsoleConfigView,
    pub session: SessionSlot,
    pub txn: TxnState,
    pub run: RunState,
    pub rev: u64,
    pub ddl_pending: bool,
}

pub enum SessionSlot {
    Empty,
    Idle(Session),
    Busy {
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

/// Disconnect or close reassigned the slot while a task held the session. The task's edits no
/// longer apply, and it must stop.
pub struct Orphaned;

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
                SessionSlot::Busy { backend_pid, .. } => SessionState::Open { backend_pid: *backend_pid },
                SessionSlot::Lost { reason, txn_lost } => SessionState::Lost { reason: reason.clone(), txn_lost: *txn_lost },
            },
            txn: inner.txn,
            run: inner.run.clone(),
        }
    }

    pub fn publish(&self, inner: &mut ConsoleInner, shared: &Shared) -> ConsoleState {
        inner.rev += 1;
        let state = self.snapshot(inner);
        *self.latest.lock().unwrap() = state.clone();
        if !self.closed.load(Ordering::Relaxed) {
            shared.emit(AppEvent::ConsoleChanged(state.clone()));
        }
        state
    }

    pub fn output(&self, shared: &Shared, run_id: RunId, body: OutputBody) {
        self.output_all(shared, run_id, vec![body]);
    }

    pub fn output_all(&self, shared: &Shared, run_id: RunId, bodies: Vec<OutputBody>) {
        if bodies.is_empty() || self.closed.load(Ordering::Relaxed) {
            return;
        }
        let at_ms = now_ms();
        shared.emit(AppEvent::ConsoleOutput {
            tab_id: self.tab,
            entries: bodies.into_iter().map(|body| OutputEntry { at_ms, run_id, body }).collect(),
        });
    }

    pub fn take_session(&self, inner: &mut ConsoleInner, run_id: RunId) -> Option<(Session, Arc<AtomicBool>)> {
        let SessionSlot::Idle(_) = inner.session else { return None };
        let SessionSlot::Idle(session) = std::mem::replace(&mut inner.session, SessionSlot::Empty) else { unreachable!() };
        let stop = Arc::new(AtomicBool::new(false));
        inner.session = SessionSlot::Busy {
            run_id,
            backend_pid: session.backend_pid,
            cancel: session.cancel_handle(),
            stop: stop.clone(),
        };
        Some((session, stop))
    }

    /// The one way a task that took the session edits console state. The edit applies and is
    /// published only while `run_id` still owns the slot; otherwise the task is `Orphaned`.
    pub async fn edit<T>(&self, shared: &Shared, run_id: RunId, edit: impl FnOnce(&mut ConsoleInner) -> T) -> Result<T, Orphaned> {
        let mut inner = self.inner.lock().await;
        if !matches!(inner.session, SessionSlot::Busy { run_id: r, .. } if r == run_id) {
            return Err(Orphaned);
        }
        let out = edit(&mut inner);
        self.publish(&mut inner, shared);
        Ok(out)
    }

    /// Puts the session back after a run or a transaction command and applies its final `txn`.
    pub fn return_session(inner: &mut ConsoleInner, session: Session, txn: TxnState, lost: Option<String>) {
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

    /// Cancels any run and drops the session; the console itself stays. A task holding the
    /// session finds itself `Orphaned` at its next edit, so the run is finished here: the
    /// statement in flight is Cancelled and the rest Skipped.
    pub async fn drop_session(&self, shared: &Shared) {
        let mut inner = self.inner.lock().await;
        if let SessionSlot::Busy { cancel, stop, .. } = &inner.session {
            stop.store(true, Ordering::Relaxed);
            let cancel = cancel.clone();
            tokio::spawn(async move { cancel.cancel().await });
        }
        inner.session = SessionSlot::Empty;
        inner.txn = TxnState::Idle;
        inner.ddl_pending = false;
        if let RunState::Running { run_id, started_at_ms, statements } = &mut inner.run {
            let mut in_flight = true;
            for s in statements.iter_mut() {
                if matches!(s.status, StmtStatus::Pending | StmtStatus::Preparing | StmtStatus::Rows { done: false, .. }) {
                    s.status = if in_flight { StmtStatus::Cancelled } else { StmtStatus::Skipped };
                    in_flight = false;
                }
            }
            inner.run = RunState::Finished {
                run_id: *run_id,
                elapsed_ms: (now_ms() - *started_at_ms).clamp(0, u32::MAX as i64) as u32,
                statements: std::mem::take(statements),
                outcome: RunOutcome::Cancelled,
            };
        }
        self.publish(&mut inner, shared);
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
    pub txn: TxnState,
    pub schema: Option<String>,
    /// The database the session is on; catalog refreshes and history rows name it.
    pub database: String,
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

/// Every console write goes through `Console::edit`, so an orphaned task returns at its next
/// write and drops the session with it.
pub async fn run_task(console: Arc<Console>, shared: Arc<Shared>, mut session: Session, plan: RunPlan, stop: Arc<AtomicBool>) -> Result<(), Orphaned> {
    let started = Instant::now();
    let run_id = plan.run_id;
    let map = OffsetMap::new(&plan.text);
    let settings = shared.settings();
    let caps = Caps { max_rows: settings.max_rows, max_bytes: settings.max_result_bytes };
    let mut txn = plan.txn;
    let mut outcome = RunOutcome::Ok;
    let mut fatal = None;

    if session.search_path != plan.schema
        && let Err(e) = session.set_search_path(plan.schema.as_deref()).await
    {
        let error = e.as_db_error().map_or_else(|| transport_error(&e), |db| query_error(db, None));
        console.output(&shared, run_id, OutputBody::Error { statement: None, error });
    }

    let mut index = 0;
    while index < plan.statements.len() {
        let stmt = &plan.statements[index];
        let i = index as u16;
        if stop.load(Ordering::Relaxed) {
            set_status(&console, &shared, run_id, i, StmtStatus::Cancelled).await?;
            outcome = RunOutcome::Cancelled;
            break;
        }
        let sql = stmt.span.text(&plan.text);

        if needs_implicit_begin(plan.mode, txn, &stmt.kind) {
            match session.client.batch_execute("BEGIN").await {
                Ok(()) => {
                    txn = TxnState::Active;
                    console.edit(&shared, run_id, |inner| inner.txn = txn).await?;
                    console.output(&shared, run_id, OutputBody::Info { message: "BEGIN (implicit)".into() });
                }
                Err(e) => {
                    let error = e.as_db_error().map_or_else(|| transport_error(&e), |db| query_error(db, None));
                    console.output(&shared, run_id, OutputBody::Error { statement: Some(i), error });
                    outcome = RunOutcome::Failed;
                    break;
                }
            }
        }

        console.output(&shared, run_id, statement_line(i, sql));
        set_status(&console, &shared, run_id, i, StmtStatus::Preparing).await?;
        let prepared = session.client.prepare(sql).await;
        // A cancel that reached the backend while it was idle between prepare and execute is lost.
        if prepared.is_ok() && stop.load(Ordering::Relaxed) {
            set_status(&console, &shared, run_id, i, StmtStatus::Cancelled).await?;
            console.output(&shared, run_id, OutputBody::Info { message: "Cancelled.".into() });
            outcome = RunOutcome::Cancelled;
            break;
        }
        let result = match prepared {
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
                console
                    .edit(&shared, run_id, |inner| {
                        console.results.lock().unwrap().push(set.clone());
                        Console::statements_mut(inner)[index].status = StmtStatus::Rows { result: set.meta(), done: false };
                    })
                    .await?;
                run_rows(&console, &shared, &mut session, sql, &set, &caps, i).await?.map_err(|e| stmt_error(e, &map, &stmt.span))
            }
        };

        let cancelled = stop.load(Ordering::Relaxed)
            && matches!(&result, Err(e) if e.sqlstate.as_deref() == Some(QUERY_CANCELED));
        if let Err(e) = &result
            && e.severity == "FATAL"
        {
            fatal = Some(e.message.clone());
        }
        txn = txn_after(txn, &stmt.kind, if result.is_ok() { StmtOutcome::Ok } else { StmtOutcome::Err });

        let (status, line, history) = match &result {
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
        let invalidates = if result.is_ok() { stmt.kind.invalidates() } else { Invalidates::Nothing };
        console
            .edit(&shared, run_id, |inner| {
                inner.txn = txn;
                Console::statements_mut(inner)[index].status = status;
                if invalidates == Invalidates::Catalog {
                    inner.ddl_pending = true;
                }
                if inner.ddl_pending && txn == TxnState::Idle {
                    inner.ddl_pending = false;
                    shared.schedule_catalog_refresh(inner.config.db());
                }
            })
            .await?;
        if invalidates == Invalidates::DatabaseList {
            shared.schedule_database_list_refresh(plan.connection.id);
        }
        let mut lines = notice_lines(&mut session);
        lines.push(line);
        console.output_all(&shared, run_id, lines);
        shared.record_history(HistoryInsert {
            at_ms: now_ms(),
            connection_id: plan.connection.id,
            connection_name: plan.connection.name.clone(),
            database: plan.database.clone(),
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
    console
        .edit(&shared, run_id, |inner| {
            let statements = Console::statements_mut(inner);
            for s in statements.iter_mut().skip(index) {
                if matches!(s.status, StmtStatus::Pending) {
                    s.status = StmtStatus::Skipped;
                }
            }
            let statements = statements.clone();
            if let Some(reason) = &lost {
                let message = if txn != TxnState::Idle {
                    format!("Transaction rolled back: connection lost ({reason})")
                } else {
                    format!("Session reset: connection lost ({reason})")
                };
                console.output(&shared, run_id, OutputBody::Info { message });
            }
            Console::return_session(inner, session, txn, lost);
            inner.run = RunState::Finished { run_id, elapsed_ms: elapsed_ms(started), statements, outcome };
        })
        .await
}

async fn set_status(console: &Console, shared: &Shared, run_id: RunId, index: u16, status: StmtStatus) -> Result<(), Orphaned> {
    console.edit(shared, run_id, |inner| Console::statements_mut(inner)[index as usize].status = status).await
}

fn publish_notices(console: &Console, shared: &Shared, session: &mut Session, run_id: RunId) {
    console.output_all(shared, run_id, notice_lines(session));
}

pub fn notice_lines(session: &mut Session) -> Vec<OutputBody> {
    session.drain_notices().iter().map(notice_body).collect()
}

/// Caps the logged text so one huge pasted statement cannot bloat the webview's 5,000-entry log.
const STATEMENT_TEXT_CAP: usize = 2_000;

pub fn statement_line(statement: u16, sql: &str) -> OutputBody {
    let text = match sql.char_indices().nth(STATEMENT_TEXT_CAP) {
        Some((cut, _)) => format!("{}…", &sql[..cut]),
        None => sql.to_owned(),
    };
    OutputBody::Statement { statement, text }
}

fn notice_body(n: &DbError) -> OutputBody {
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
/// The outer error is the run losing its slot; the inner one is the query failing.
async fn run_rows(
    console: &Console,
    shared: &Shared,
    session: &mut Session,
    sql: &str,
    set: &Arc<ResultSet>,
    caps: &Caps,
    index: u16,
) -> Result<Result<StmtOk, tokio_postgres::Error>, Orphaned> {
    let ncols = set.columns.len();
    let started = Instant::now();
    let mut stream = match session.client.simple_query_raw(sql).await {
        Ok(stream) => std::pin::pin!(stream),
        Err(e) => return Ok(Err(e)),
    };
    let mut last_emit = Instant::now();
    while let Some(message) = stream.next().await {
        match message {
            Ok(SimpleQueryMessage::Row(row)) => set.push_row((0..ncols).map(|c| row.try_get(c).ok().flatten()), caps),
            Ok(_) => {}
            Err(e) => return Ok(Err(e)),
        }
        if last_emit.elapsed() >= STREAM_EMIT_INTERVAL {
            last_emit = Instant::now();
            set.set_elapsed(elapsed_ms(started));
            let status = StmtStatus::Rows { result: set.meta(), done: false };
            console.edit(shared, set.r#ref.run_id, |inner| Console::statements_mut(inner)[index as usize].status = status).await?;
            publish_notices(console, shared, session, set.r#ref.run_id);
        }
    }
    set.set_elapsed(elapsed_ms(started));
    Ok(Ok(StmtOk::Rows(set.clone())))
}

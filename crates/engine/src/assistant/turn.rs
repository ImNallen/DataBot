//! One turn: start or resume the provider process, send the message with its context, fold the
//! events into entries, run tools behind the gate, and close the process at the end. The task
//! owns the process, so its stdin has one writer, and every tool future is polled here.

use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::future::{AbortHandle, Abortable, BoxFuture};
use futures_util::stream::{FuturesUnordered, StreamExt};
use serde_json::Value;
use tokio::sync::mpsc;

use super::chat::{Chat, Closing, Gated, LastContext, Refusal, TurnControl, wait};
use super::tools::{self, Ask, Executed, ParsedCall};
use super::{context, reply};
use crate::Shared;
use crate::console::now_ms;
use crate::model::*;
use crate::provider::agent::{Agent, Next, StartError};
use crate::provider::{AgentEvent, BlockKey, ModelResult, Open, ProbeDepth, ReplyTo, SessionStart, provider};
use crate::sql;
use crate::store::ProviderSession;
use crate::text::OffsetMap;

const SYSTEM_PROMPT: &str = include_str!("system_prompt.md");
const TEXT_PUBLISH_INTERVAL: Duration = Duration::from_millis(50);
const EXECUTION_TIMEOUT: Duration = Duration::from_secs(45);
const FAR_FUTURE: Duration = Duration::from_secs(3600);
const STOPPED_TOOL: &str = "Stopped by the user.";
const NOT_APPROVED: &str = "This call was not approved.";
const DECLINED: &str = "The user declined this tool call.";
const CANCELLED_TOOL: &str = "The call was cancelled.";
const EXPIRED_TOOL: &str = "The turn ended before an answer.";

pub(crate) struct TurnPlan {
    pub chat: Arc<Chat>,
    /// Seq of the user entry. Every entry of this turn carries it.
    pub turn: u32,
    pub options: ChatOptions,
    pub user_text: String,
    pub tab: Option<TabContext>,
    /// The last turn's process, if it is still closing. This turn starts its own only after it.
    pub closing: Option<Closing>,
}

pub(crate) async fn run_turn(shared: Arc<Shared>, plan: TurnPlan, control: mpsc::Receiver<TurnControl>) {
    let mut turn = Turn {
        shared,
        chat: plan.chat,
        seq: plan.turn,
        options: plan.options,
        user_text: plan.user_text,
        db: plan.tab.as_ref().and_then(|t| t.db.clone()),
        tab: plan.tab,
        closing: plan.closing,
        connected: Ok(()),
        catalog: None,
        texts: Vec::new(),
        tools: Vec::new(),
        stopping: None,
        session_id: None,
        agent: None,
    };
    let outcome = turn.run(control).await;
    turn.finish(outcome).await;
}

struct Turn {
    shared: Arc<Shared>,
    chat: Arc<Chat>,
    seq: u32,
    options: ChatOptions,
    user_text: String,
    tab: Option<TabContext>,
    db: Option<DatabaseRef>,
    closing: Option<Closing>,
    connected: Result<(), String>,
    catalog: Option<Arc<Catalog>>,
    texts: Vec<TextState>,
    tools: Vec<ToolState>,
    /// The deadline after which Stop kills the process.
    stopping: Option<Instant>,
    session_id: Option<String>,
    agent: Option<Agent>,
}

struct TextState {
    key: BlockKey,
    seq: u32,
    text: String,
    dirty: bool,
    done: bool,
}

struct ToolState {
    call: ToolCallId,
    seq: u32,
    input: Value,
    tool: ToolUse,
    status: ToolStatus,
    /// Set while the call executes, so Stop or a cancel can answer and abort it.
    running: Option<(ReplyTo, AbortHandle)>,
}

/// Which of the provider's two consults of the gate a verdict answers.
enum Site {
    /// `can_use_tool`, before the call.
    Permission(ReplyTo),
    /// The MCP `tools/call`, where the tool runs.
    Call(ReplyTo),
}

enum Work {
    Gated { site: Site, call: ToolCallId, parsed: ParsedCall, verdict: Result<(), Refusal> },
    Tool { reply: ReplyTo, call: ToolCallId, executed: Executed },
}

type Waits = FuturesUnordered<BoxFuture<'static, Work>>;
type Execs = FuturesUnordered<Abortable<BoxFuture<'static, Work>>>;

enum Started {
    Agent(Agent),
    Stopped,
}

/// What one process made of the turn.
enum Attempt {
    Done(TurnOutcome),
    /// A resumed session the provider no longer has, found at start or at the first result
    /// before any text or tool use. The turn retries once as a new session.
    Lost,
}

impl Turn {
    async fn run(&mut self, mut control: mpsc::Receiver<TurnControl>) -> TurnOutcome {
        if let Some(db) = self.db.clone() {
            let connect = self.shared.connect(db.connection_id);
            tokio::select! {
                result = connect => self.connected = result.map(|_| ()).map_err(|e| crate::connection::connect_error_text(&e)),
                Some(TurnControl::Stop { .. }) = control.recv() => return TurnOutcome::Stopped,
            }
            if self.connected.is_ok() {
                self.catalog = self.shared.catalog(&db).await.ok();
            }
        }
        if let Some(closing) = self.closing.take() {
            tokio::select! {
                reaped = closing.wait() => if !reaped { eprintln!("chat {} starts its next process while the last one is still closing", self.chat.id.0) },
                Some(TurnControl::Stop { .. }) = control.recv() => return TurnOutcome::Stopped,
            }
        }
        let cfg = self.provider_config();
        let stored = self.chat.inner.lock().unwrap().record.session.clone();
        let mut resume = stored.as_ref().filter(|s| s.provider == self.options.provider && s.config_dir == cfg.config_dir).map(|s| s.id.clone());
        // The provider keeps its transcript under the config dir the session was made in, so a
        // changed one cannot resume and the chat restarts with a recap.
        let mut recap = if stored.is_some() && resume.is_none() { Some(self.recap()) } else { None };
        loop {
            match self.attempt(&mut control, &cfg, resume.take(), recap.as_deref()).await {
                Attempt::Done(outcome) => return outcome,
                Attempt::Lost => {
                    eprintln!("chat {} could not resume its session; restarting it with a recap", self.chat.id.0);
                    self.forget_session();
                    recap = Some(self.recap());
                }
            }
        }
    }

    /// One process: start it, resuming when asked, send the prompt, and run the event loop until
    /// the turn ends or the resumed session proves lost. Any other failure keeps the session.
    async fn attempt(&mut self, control: &mut mpsc::Receiver<TurnControl>, cfg: &ProviderConfig, resume: Option<String>, recap: Option<&str>) -> Attempt {
        let resumed = resume.is_some();
        let p = provider(self.options.provider);
        let mut agent = match self.start_agent(control, cfg, resume).await {
            Ok(Started::Agent(agent)) => agent,
            Ok(Started::Stopped) => return Attempt::Done(TurnOutcome::Stopped),
            Err(e) => {
                let error = start_failure(e);
                return if resumed && p.session_lost(&error) { Attempt::Lost } else { Attempt::Done(TurnOutcome::Failed { error }) };
            }
        };
        if recap.is_some() {
            self.notice(format!("{} could not resume this chat, so it was restarted with a summary of the conversation.", cfg.display_name));
        }
        let prompt = self.prompt(!resumed, recap);
        self.set_phase(TurnPhase::Working);
        let lines = agent.codec.user_turn(&prompt);
        if let Err(e) = agent.write(lines).await {
            self.agent = Some(agent);
            return Attempt::Done(TurnOutcome::Failed { error: AgentError::Exited { code: None, detail: e.to_string() } });
        }
        let mut waits: Waits = FuturesUnordered::new();
        let mut execs: Execs = FuturesUnordered::new();
        let mut tick = tokio::time::interval(TEXT_PUBLISH_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut streamed = false;
        let outcome = loop {
            let deadline = self.stopping.unwrap_or_else(|| Instant::now() + FAR_FUTURE);
            let ended = tokio::select! {
                next = agent.next() => match next {
                    Next::Eof { code } => Some(Attempt::Done(TurnOutcome::Failed { error: AgentError::Exited { code, detail: agent.stderr_tail() } })),
                    Next::Event(event) => {
                        streamed |= matches!(event, AgentEvent::Text { .. } | AgentEvent::ToolUse { .. } | AgentEvent::Permission { .. } | AgentEvent::ToolCall { .. });
                        match self.on_event(&mut agent, event, &mut waits, &mut execs).await {
                            Some(TurnOutcome::Failed { error }) if resumed && !streamed && p.session_lost(&error) => Some(Attempt::Lost),
                            Some(outcome) => Some(Attempt::Done(outcome)),
                            None => None,
                        }
                    }
                    Next::Flush => None,
                },
                Some(work) = waits.next(), if !waits.is_empty() => {
                    self.on_work(&mut agent, work, &mut execs).await;
                    None
                }
                Some(done) = execs.next(), if !execs.is_empty() => {
                    if let Ok(work) = done {
                        self.on_work(&mut agent, work, &mut execs).await;
                    }
                    None
                }
                Some(TurnControl::Stop { grace }) = control.recv(), if self.stopping.is_none() => {
                    self.on_stop(&mut agent, grace).await;
                    None
                }
                _ = tick.tick() => {
                    self.publish_texts(false);
                    None
                }
                _ = tokio::time::sleep_until(deadline.into()), if self.stopping.is_some() => Some(Attempt::Done(TurnOutcome::Stopped)),
            };
            if let Err(e) = agent.flush().await {
                eprintln!("chat {} write failed: {e}", self.chat.id.0);
            }
            if let Some(outcome) = ended {
                break outcome;
            }
        };
        match &outcome {
            Attempt::Lost => agent.close().await,
            Attempt::Done(_) => self.agent = Some(agent),
        }
        outcome
    }

    /// The provider no longer has the stored session, so no later turn should try it.
    fn forget_session(&mut self) {
        self.chat.inner.lock().unwrap().record.session = None;
        self.chat.store_record(&self.shared);
    }

    fn provider_config(&self) -> ProviderConfig {
        self.shared.settings().providers.into_iter().find(|c| c.provider == self.options.provider).unwrap_or_else(|| default_config(self.options.provider))
    }

    async fn start_agent(&mut self, control: &mut mpsc::Receiver<TurnControl>, cfg: &ProviderConfig, resume: Option<String>) -> Result<Started, StartError> {
        let p = provider(self.options.provider);
        let host = self.shared.host_env().await;
        let start = SessionStart { model: Some(self.options.model.clone()), effort: self.options.effort.clone(), resume };
        let spec = p.launch(cfg, host, &start).map_err(|e| match e {
            AgentError::NotFound { binary } => StartError::NotFound { binary },
            other => StartError::Reported(other),
        })?;
        let codec = p.codec(cfg, Open { system_prompt: SYSTEM_PROMPT, tools: &tools::TOOLS });
        let shared = self.shared.clone();
        tokio::select! {
            started = Agent::start(&shared, spec, codec) => started.map(|(agent, _)| Started::Agent(agent)),
            Some(TurnControl::Stop { .. }) = control.recv() => Ok(Started::Stopped),
        }
    }

    /// The `<l1_context>` block, the recap when the session was lost, and the user's text.
    fn prompt(&self, fresh_session: bool, recap: Option<&str>) -> String {
        let instance = self.db.as_ref().and_then(|db| self.shared.instance(db.connection_id));
        let config = self.db.as_ref().and_then(|db| self.shared.config(db.connection_id));
        let server_version = instance.as_ref().map(|i| i.server.version.clone());
        let connection = config.as_ref().map(|c| context::ConnectionFacts { name: &c.name, server_version: server_version.as_deref(), connected: self.connected.as_ref().map(|_| ()).map_err(String::as_str) });
        let shown: Vec<String> = match (&instance, &self.catalog, &self.db) {
            (Some(instance), Some(catalog), Some(db)) => crate::view::resolve_schemas(&instance.view().database(&db.database, &instance.home), catalog),
            _ => Vec::new(),
        };
        let tab_text = self.tab.as_ref().map_or("", |t| t.text.as_str());
        let picked = self.tab.as_ref().and_then(|t| {
            let map = OffsetMap::new(&t.text);
            let target = match t.target {
                RunTarget::All => sql::ByteTarget::All,
                RunTarget::Cursor { offset } => sql::ByteTarget::Cursor(map.from_utf16(offset)),
                RunTarget::Selection { from, to } => sql::ByteTarget::Selection { from: map.from_utf16(from), to: map.from_utf16(to) },
            };
            let spans = sql::pick(&sql::split_statements(&t.text), &t.text, target);
            Some((spans.first()?.start, spans.last()?.end))
        });
        let selected = matches!(self.tab.as_ref().map(|t| t.target), Some(RunTarget::Selection { from, to }) if from.0 < to.0);
        let last_error = self.tab.as_ref().and_then(|t| self.last_run_error(t));
        let attachment = self.attachment();
        let sql_hash = {
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            tab_text.hash(&mut hasher);
            hasher.finish()
        };
        let session = self.chat.inner.lock().unwrap().record.session.as_ref().map(|s| s.id.clone());
        let last = self.chat.inner.lock().unwrap().last_context.clone();
        let same_session = !fresh_session && last.as_ref().zip(session.as_ref()).is_some_and(|(l, s)| l.session == *s);
        let outline = match (&last, &self.catalog, &self.db) {
            (Some(l), Some(c), Some(db)) if same_session && l.db == *db && l.catalog_version == c.version => context::Repeat::Unchanged,
            _ => context::Repeat::Full,
        };
        let tab_sql = match &last {
            Some(l) if same_session && l.sql_hash == sql_hash && self.db.as_ref() == Some(&l.db) => context::Repeat::Unchanged,
            _ => context::Repeat::Full,
        };
        let tab = self.tab.as_ref().map(|t| context::TabFacts { title: &t.title, text: tab_text, picked, selected, last_error: last_error.as_deref() });
        let block = context::build(&context::ContextInput { connection, db: self.db.as_ref(), catalog: self.catalog.as_deref(), shown_schemas: &shown, tab, tab_sql, attachment: attachment.as_ref(), outline });
        if let (Some(db), Some(catalog)) = (&self.db, &self.catalog) {
            self.chat.inner.lock().unwrap().last_context = Some(LastContext { session: session.unwrap_or_default(), db: db.clone(), catalog_version: catalog.version, sql_hash });
        }
        match recap {
            Some(recap) => format!("{recap}\n\n{block}\n\n{}", self.user_text),
            None => format!("{block}\n\n{}", self.user_text),
        }
    }

    /// The user entry's attachment, as stored at send.
    fn attachment(&self) -> Option<Attachment> {
        let inner = self.chat.inner.lock().unwrap();
        match inner.live.get(&self.seq).map(|s| &s.entry) {
            Some(Entry::User { attachment, .. }) => attachment.clone(),
            _ => None,
        }
    }

    /// The tab's last run, when a statement failed.
    fn last_run_error(&self, tab: &TabContext) -> Option<String> {
        let console = self.shared.console(tab.tab_id)?;
        let error = {
            let latest = console.latest.lock().unwrap();
            let RunState::Finished { statements, .. } = &latest.run else { return None };
            statements.iter().find_map(|s| match &s.status {
                StmtStatus::Failed { error } => Some(error.clone()),
                _ => None,
            })?
        };
        let mut text = error.message;
        if let Some(detail) = &error.detail {
            text.push_str(&format!(" DETAIL: {detail}"));
        }
        if let Some(hint) = &error.hint {
            text.push_str(&format!(" HINT: {hint}"));
        }
        if let Some(position) = error.position {
            let byte = OffsetMap::new(&tab.text).from_utf16(position);
            let line = tab.text[..byte].matches('\n').count() + 1;
            let column = tab.text[..byte].rsplit('\n').next().map_or(0, |l| l.chars().count()) + 1;
            text.push_str(&format!(" (line {line}, column {column})"));
        }
        Some(text)
    }

    async fn on_event(&mut self, agent: &mut Agent, event: AgentEvent, waits: &mut Waits, execs: &mut Execs) -> Option<TurnOutcome> {
        match event {
            AgentEvent::Ready(_) => {}
            AgentEvent::TurnStarted { session_id } => self.set_session(session_id),
            AgentEvent::Text { block, delta } => self.text_delta(block, &delta),
            AgentEvent::TextDone { block } => self.text_done(block),
            AgentEvent::ToolUse { call, name, input } => self.ensure_tool(&call, &name, &input),
            AgentEvent::Permission { reply, call, name, input } => self.on_gate(agent, Site::Permission(reply), call, &name, input, waits, execs).await,
            AgentEvent::ToolCall { reply, call, name, input } => self.on_gate(agent, Site::Call(reply), call, &name, input, waits, execs).await,
            AgentEvent::ToolCancelled { call } => {
                if let Some(state) = self.tool_mut(&call)
                    && let Some((_, abort)) = state.running.take()
                {
                    abort.abort();
                    self.set_tool_status(&call, ToolStatus::Failed { message: CANCELLED_TOOL.into() });
                }
                self.chat.cancel(&call);
            }
            AgentEvent::TurnEnded(outcome) => return Some(outcome),
        }
        None
    }

    fn set_session(&mut self, session_id: String) {
        let cfg = self.provider_config();
        let changed = {
            let mut inner = self.chat.inner.lock().unwrap();
            let next = ProviderSession { provider: self.options.provider, id: session_id.clone(), config_dir: cfg.config_dir };
            let changed = inner.record.session.as_ref() != Some(&next);
            if changed {
                inner.record.session = Some(next);
            }
            if let Some(last) = inner.last_context.as_mut()
                && last.session.is_empty()
            {
                last.session = session_id.clone();
            }
            changed
        };
        if changed {
            self.chat.store_record(&self.shared);
        }
        self.session_id = Some(session_id);
    }

    fn next_seq(&self) -> u32 {
        let mut inner = self.chat.inner.lock().unwrap();
        let seq = inner.next_seq;
        inner.next_seq += 1;
        seq
    }

    fn text_delta(&mut self, key: BlockKey, delta: &str) {
        match self.texts.iter_mut().find(|t| t.key == key) {
            Some(state) => {
                state.text.push_str(delta);
                state.dirty = true;
            }
            None => {
                let seq = self.next_seq();
                self.texts.push(TextState { key, seq, text: delta.to_owned(), dirty: true, done: false });
            }
        }
    }

    fn text_done(&mut self, key: BlockKey) {
        let Some(state) = self.texts.iter_mut().find(|t| t.key == key) else { return };
        state.done = true;
        state.dirty = true;
        self.publish_texts(false);
    }

    /// Publishes every changed text block. The 50 ms tick calls it, so a streaming block costs at
    /// most 20 snapshots a second. `close` marks every open block done, at turn end.
    fn publish_texts(&mut self, close: bool) {
        for state in &mut self.texts {
            if close && !state.done {
                state.done = true;
                state.dirty = true;
            }
            if !state.dirty {
                continue;
            }
            state.dirty = false;
            let entry = Entry::Text { blocks: resolve_blocks(reply::parse_text(&state.text, state.done).blocks, self.catalog.as_deref()), done: state.done };
            if state.done {
                self.chat.store_entry(&self.shared, state.seq, self.seq, &entry);
            }
            self.chat.publish_entry(&self.shared, state.seq, self.seq, entry);
        }
    }

    /// Creates the card, or refreshes it when the provider's ask carries other arguments than its
    /// `tool_use` block did, so the card, the ledger, and `updatedInput` hold what the user sees.
    fn ensure_tool(&mut self, call: &ToolCallId, name: &str, input: &Value) {
        if let Some(state) = self.tools.iter_mut().find(|t| t.call == *call) {
            if state.input == *input {
                return;
            }
            state.input = input.clone();
            state.tool = tools::describe(name, input, self.catalog.as_deref());
            let status = state.status.clone();
            return self.set_tool_status(call, status);
        }
        let seq = self.next_seq();
        let tool = tools::describe(name, input, self.catalog.as_deref());
        self.tools.push(ToolState { call: call.clone(), seq, input: input.clone(), tool: tool.clone(), status: ToolStatus::Running, running: None });
        let entry = Entry::Tool { call: call.clone(), tool, status: ToolStatus::Running };
        self.chat.store_entry(&self.shared, seq, self.seq, &entry);
        self.chat.publish_entry(&self.shared, seq, self.seq, entry);
    }

    fn tool_mut(&mut self, call: &ToolCallId) -> Option<&mut ToolState> {
        self.tools.iter_mut().find(|t| t.call == *call)
    }

    fn set_tool_status(&mut self, call: &ToolCallId, status: ToolStatus) {
        let Some(state) = self.tool_mut(call) else { return };
        state.status = status.clone();
        let (seq, entry) = (state.seq, Entry::Tool { call: call.clone(), tool: state.tool.clone(), status });
        self.chat.store_entry(&self.shared, seq, self.seq, &entry);
        self.chat.publish_entry(&self.shared, seq, self.seq, entry);
    }

    fn set_phase(&self, phase: TurnPhase) {
        {
            let mut inner = self.chat.inner.lock().unwrap();
            match &mut inner.status {
                ChatStatus::Running { phase: current, .. } if *current != phase => *current = phase,
                _ => return,
            }
        }
        self.chat.publish_state(&self.shared);
    }

    fn refresh_phase(&self) {
        self.set_phase(if self.chat.has_pending() { TurnPhase::AwaitingApproval } else { TurnPhase::Working });
    }

    /// Both places the provider consults the gate: `can_use_tool` before a call, where the user's
    /// wait happens, and the MCP `tools/call`, where the tool runs only on a recorded `Run` with
    /// the same input. A provider that skipped the ask creates the approval at the call. After
    /// Stop, both deny at once.
    async fn on_gate(&mut self, agent: &mut Agent, site: Site, call: ToolCallId, name: &str, input: Value, waits: &mut Waits, execs: &mut Execs) {
        self.ensure_tool(&call, name, &input);
        let parsed = tools::parse_call(name, &input);
        if self.stopping.is_some() {
            return self.settle(agent, site, call, parsed, Err(Refusal::Stopped), execs).await;
        }
        let ask = tools::policy(&parsed, self.chat.permission());
        match self.chat.gate(&self.shared.assistant, &call, &input, &ask) {
            Gated::Run => self.settle(agent, site, call, parsed, Ok(()), execs).await,
            Gated::Deny(why) => self.settle(agent, site, call, parsed, Err(why), execs).await,
            Gated::Wait { approval, answer, fresh } => {
                if fresh && let Ask::User(reason) = ask {
                    self.set_tool_status(&call, ToolStatus::AwaitingApproval { approval, reason });
                    self.refresh_phase();
                }
                waits.push(Box::pin(async move { Work::Gated { site, call, parsed, verdict: wait(answer).await } }));
            }
        }
    }

    /// Answers the provider at `site` with the verdict and shows it on the card. The allow reply
    /// echoes the card's input, so the tool runs on what the user saw.
    async fn settle(&mut self, agent: &mut Agent, site: Site, call: ToolCallId, parsed: ParsedCall, verdict: Result<(), Refusal>, execs: &mut Execs) {
        match (site, verdict) {
            (Site::Permission(reply), Ok(())) => {
                let input = self.tool_mut(&call).expect("on_gate made the card").input.clone();
                let lines = agent.codec.permission(&reply, Decision::Run, &input, "");
                agent.write(lines).await.ok();
                if matches!(self.tool_mut(&call).map(|t| &t.status), Some(ToolStatus::AwaitingApproval { .. })) {
                    self.set_tool_status(&call, ToolStatus::Running);
                }
            }
            (Site::Permission(reply), Err(why)) => {
                let lines = agent.codec.permission(&reply, Decision::Deny, &Value::Null, &refusal_text(&why));
                agent.write(lines).await.ok();
                self.set_tool_status(&call, refusal_status(why));
            }
            (Site::Call(reply), Ok(())) => self.start_tool(reply, call, parsed, execs),
            (Site::Call(reply), Err(why)) => {
                let lines = agent.codec.tool_result(&reply, &ModelResult { text: refusal_text(&why), is_error: true });
                agent.write(lines).await.ok();
                if matches!(self.tool_mut(&call).map(|t| &t.status), Some(ToolStatus::Running | ToolStatus::AwaitingApproval { .. })) {
                    self.set_tool_status(&call, refusal_status(why));
                }
            }
        }
        self.refresh_phase();
    }

    fn start_tool(&mut self, reply: ReplyTo, call: ToolCallId, parsed: ParsedCall, execs: &mut Execs) {
        if matches!(self.tool_mut(&call).map(|t| &t.status), Some(ToolStatus::AwaitingApproval { .. })) {
            self.set_tool_status(&call, ToolStatus::Running);
        }
        let (shared, db, id) = (self.shared.clone(), self.db.clone(), call.clone());
        let reply_for_work = reply.clone();
        let (future, abort) = futures_util::future::abortable(Box::pin(async move {
            let executed = match tokio::time::timeout(EXECUTION_TIMEOUT, tools::execute(&shared, db.as_ref(), parsed)).await {
                Ok(executed) => executed,
                Err(_) => Executed::failed(format!("The tool did not finish within {} s.", EXECUTION_TIMEOUT.as_secs())),
            };
            Work::Tool { reply: reply_for_work, call: id, executed }
        }) as BoxFuture<'static, Work>);
        if let Some(state) = self.tool_mut(&call) {
            state.running = Some((reply, abort));
        }
        execs.push(future);
    }

    async fn on_work(&mut self, agent: &mut Agent, work: Work, execs: &mut Execs) {
        match work {
            Work::Gated { site, call, parsed, verdict } => self.settle(agent, site, call, parsed, verdict, execs).await,
            Work::Tool { reply, call, executed } => {
                let lines = agent.codec.tool_result(&reply, &executed.for_model);
                agent.write(lines).await.ok();
                if let Some(state) = self.tool_mut(&call) {
                    state.running = None;
                }
                self.set_tool_status(&call, executed.status);
            }
        }
    }

    /// Pending approvals are denied here; each waiter then answers its provider request and marks
    /// its card.
    async fn on_stop(&mut self, agent: &mut Agent, grace: Duration) {
        self.stopping = Some(Instant::now() + grace);
        self.chat.deny_pending(Refusal::Stopped);
        let running: Vec<(ToolCallId, ReplyTo, AbortHandle)> = self.tools.iter_mut().filter_map(|t| t.running.take().map(|(reply, abort)| (t.call.clone(), reply, abort))).collect();
        for (call, reply, abort) in running {
            abort.abort();
            let lines = agent.codec.tool_result(&reply, &ModelResult { text: STOPPED_TOOL.into(), is_error: true });
            agent.write(lines).await.ok();
            self.set_tool_status(&call, ToolStatus::Failed { message: STOPPED_TOOL.into() });
        }
        let lines = agent.codec.interrupt();
        agent.write(lines).await.ok();
        self.refresh_phase();
    }

    /// The stored conversation before this turn, as plain text, for a session that cannot
    /// continue.
    fn recap(&self) -> String {
        let earlier: Vec<(u32, u32, Entry)> = self.shared.store.chat_entries(self.chat.id).unwrap_or_default().into_iter().filter(|(_, turn, _)| *turn != self.seq).collect();
        reply::recap(&earlier, super::RECAP_MAX_CHARS)
    }

    fn notice(&mut self, text: String) {
        let seq = self.next_seq();
        let entry = Entry::Notice { text };
        self.chat.store_entry(&self.shared, seq, self.seq, &entry);
        self.chat.publish_entry(&self.shared, seq, self.seq, entry);
    }

    /// In this order, so a crash at any step leaves rows `recover` can close. The chat is Idle as
    /// soon as its End is out; the process closes on its own task, and the next turn waits for
    /// that before it starts its own.
    async fn finish(&mut self, outcome: TurnOutcome) {
        self.publish_texts(true);
        if outcome == TurnOutcome::Stopped {
            for call in self.chat.deny_pending(Refusal::Stopped) {
                self.set_tool_status(&call, ToolStatus::Denied { stopped: true });
            }
        }
        let open: Vec<ToolCallId> = self.tools.iter_mut().filter(|t| matches!(t.status, ToolStatus::Running | ToolStatus::AwaitingApproval { .. })).map(|t| {
            if let Some((_, abort)) = t.running.take() {
                abort.abort();
            }
            t.call.clone()
        }).collect();
        for call in open {
            self.set_tool_status(&call, ToolStatus::Expired);
        }
        let suggestions = if outcome == TurnOutcome::Completed { self.texts.last().map(|t| reply::parse_text(&t.text, true).followups).unwrap_or_default() } else { Vec::new() };
        let seq = self.next_seq();
        let end = Entry::End { at_ms: now_ms(), outcome: outcome.clone(), suggestions };
        self.chat.store_entry(&self.shared, seq, self.seq, &end);
        self.chat.publish_entry(&self.shared, seq, self.seq, end);
        let closing = self.agent.take().map(|agent| Closing::start(&self.shared, agent));
        {
            let mut inner = self.chat.inner.lock().unwrap();
            inner.record.entry_count = inner.next_seq;
            inner.record.updated_at_ms = now_ms();
            inner.ledger = Default::default();
            inner.turn = None;
            // A turn stopped before it started a process leaves its predecessor's handle in place.
            if closing.is_some() {
                inner.closing = closing;
            }
            if !inner.deleted() {
                inner.status = ChatStatus::Idle;
            }
            inner.live.clear();
            if let Some(last) = inner.last_context.as_mut()
                && let Some(session) = &self.session_id
            {
                last.session = session.clone();
            }
        }
        self.chat.store_record(&self.shared);
        self.chat.publish_state(&self.shared);
        if let Some(db) = &self.db {
            self.shared.reconcile(db.connection_id);
        }
        if let TurnOutcome::Failed { error: AgentError::NotFound { .. } | AgentError::SignedOut | AgentError::Exited { .. } } = outcome {
            self.shared.probe(self.options.provider, ProbeDepth::Full);
        }
    }
}

/// What the model hears for a refusal.
fn refusal_text(why: &Refusal) -> String {
    match why {
        Refusal::Policy(message) => message.clone(),
        Refusal::Declined => DECLINED.into(),
        Refusal::Stopped => STOPPED_TOOL.into(),
        Refusal::Cancelled => CANCELLED_TOOL.into(),
        Refusal::Expired => EXPIRED_TOOL.into(),
        Refusal::Mismatch => NOT_APPROVED.into(),
    }
}

/// What the card shows for a refusal.
fn refusal_status(why: Refusal) -> ToolStatus {
    match why {
        Refusal::Declined => ToolStatus::Denied { stopped: false },
        Refusal::Stopped => ToolStatus::Denied { stopped: true },
        Refusal::Expired => ToolStatus::Expired,
        Refusal::Policy(_) | Refusal::Cancelled | Refusal::Mismatch => ToolStatus::Failed { message: refusal_text(&why) },
    }
}

fn start_failure(e: StartError) -> AgentError {
    match e {
        StartError::NotFound { binary } => AgentError::NotFound { binary },
        StartError::Exited { code, detail } => AgentError::Exited { code, detail },
        StartError::Reported(error) => error,
        StartError::Timeout => AgentError::Exited { code: None, detail: e.to_string() },
    }
}

/// Fills `relations` and `writes` for every closed SQL fence.
fn resolve_blocks(blocks: Vec<ReplyBlock>, catalog: Option<&Catalog>) -> Vec<ReplyBlock> {
    blocks
        .into_iter()
        .map(|block| match block {
            ReplyBlock::Sql { sql, complete: true, .. } => {
                let (relations, writes) = (reply::uses(&sql, catalog), reply::writes(&sql));
                ReplyBlock::Sql { sql, relations, writes, complete: true }
            }
            other => other,
        })
        .collect()
}

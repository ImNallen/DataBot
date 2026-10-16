//! One chat: its stored record, the running turn's slot, the approval ledger, and publishing.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{mpsc, watch};
use tokio::task::{AbortHandle, JoinHandle};

use super::Assistant;
use super::reply;
use super::tools::Ask;
use crate::Shared;
use crate::console::now_ms;
use crate::model::{AppEvent, ApprovalId, ApproveError, ChatId, ChatState, ChatStatus, DatabaseRef, Decision, Entry, EntrySnapshot, Permission, ToolCallId, TurnOutcome};
use crate::provider::agent::{Agent, CLOSE_GRACE};
use crate::store::ChatRecord;

/// How long a waiter gives the last process to close: the grace `Agent::close` allows after
/// stdin closes, then the kill and the reap.
const CLOSING_WAIT: Duration = Duration::from_secs(CLOSE_GRACE.as_secs() + 1);

pub(crate) struct Chat {
    pub id: ChatId,
    /// A std mutex, never held across an await.
    pub inner: Mutex<ChatInner>,
}

pub(crate) struct ChatInner {
    pub record: ChatRecord,
    /// False while a draft: nothing stored, nothing listed.
    pub stored: bool,
    pub status: ChatStatus,
    /// The last published rev of the chat's own snapshot.
    pub rev: u64,
    pub turn: Option<ActiveTurn>,
    /// The last turn's process while it closes. Idle does not wait for it: the next turn does,
    /// before it starts its own process, and so do delete and shutdown.
    pub closing: Option<Closing>,
    /// Entries are numbered `0..next_seq`; the record's `entry_count` catches up at turn end.
    pub next_seq: u32,
    /// Snapshots the running turn published, keyed by seq, cleared at turn end. `open` overlays
    /// them on the stored rows.
    pub live: BTreeMap<u32, EntrySnapshot>,
    pub ledger: Ledger,
    /// What the last message to the current provider session carried. Memory only: catalog
    /// versions restart with the engine.
    pub last_context: Option<LastContext>,
}

impl ChatInner {
    /// Set by `assistant_delete` under the lock. From then on the turn task's stores and
    /// publishes are no-ops, so a chat whose rows are gone cannot come back.
    fn deleted(&self) -> bool {
        self.status == ChatStatus::Deleted
    }
}

/// The turn task owns the process; this is what the rest of the engine sees of it.
pub(crate) struct ActiveTurn {
    pub db: Option<DatabaseRef>,
    pub control: mpsc::Sender<TurnControl>,
    /// The supervisor, done once the turn task is: it gives a turn that panicked or was aborted
    /// before `finish` its End.
    pub task: Option<JoinHandle<()>>,
    /// Aborts the turn task itself, whose drop kills its process.
    pub abort: Option<AbortHandle>,
}

pub(crate) enum TurnControl {
    /// Deny pending approvals, cancel running tools, interrupt, and kill after `grace`.
    Stop { grace: Duration },
}

/// A process being closed on its own task. Every clone resolves once the child is reaped.
#[derive(Clone)]
pub(crate) struct Closing(watch::Receiver<bool>);

impl Closing {
    pub(crate) fn start(shared: &Shared, agent: Agent) -> Self {
        let (reaped, handle) = watch::channel(false);
        shared.spawn(async move {
            agent.close().await;
            let _ = reaped.send(true);
        });
        Self(handle)
    }

    /// True once the child is reaped, or once its close task is gone. False after `CLOSING_WAIT`.
    pub(crate) async fn wait(mut self) -> bool {
        tokio::time::timeout(CLOSING_WAIT, self.0.wait_for(|reaped| *reaped)).await.is_ok()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct LastContext {
    pub session: String,
    pub db: DatabaseRef,
    pub catalog_version: u64,
    pub sql_hash: u64,
}

/// Approval state of one turn's tool calls, keyed by the provider's call id. Cleared at turn end.
#[derive(Default)]
pub(crate) struct Ledger {
    calls: HashMap<ToolCallId, Gate>,
}

/// Why a call does not run. The turn maps each to what the model hears and what the card shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// The policy refused it before anyone was asked: a write, a bad input, an unknown tool.
    Policy(String),
    /// The user pressed Deny.
    Declined,
    /// Stop denied it.
    Stopped,
    /// The provider cancelled the call while it waited.
    Cancelled,
    /// The turn ended before an answer.
    Expired,
    /// Called with other arguments than the ones approved.
    Mismatch,
}

type Verdict = Result<(), Refusal>;

enum Gate {
    Pending { approval: ApprovalId, input: Value, answer: watch::Sender<Option<Verdict>> },
    Run { input: Value },
    Denied { why: Refusal },
}

impl Ledger {
    /// Moves a pending call to its verdict and wakes its waiters. False when nothing was pending.
    fn decide(&mut self, call: &ToolCallId, verdict: Verdict) -> bool {
        if !matches!(self.calls.get(call), Some(Gate::Pending { .. })) {
            return false;
        }
        let Some(Gate::Pending { input, answer, .. }) = self.calls.remove(call) else { unreachable!("checked above") };
        let settled = match &verdict {
            Ok(()) => Gate::Run { input },
            Err(why) => Gate::Denied { why: why.clone() },
        };
        self.calls.insert(call.clone(), settled);
        let _ = answer.send(Some(verdict));
        true
    }

    fn pending(&self) -> Vec<ToolCallId> {
        self.calls.iter().filter(|(_, g)| matches!(g, Gate::Pending { .. })).map(|(c, _)| c.clone()).collect()
    }
}

pub(crate) enum Gated {
    Run,
    Deny(Refusal),
    /// `fresh` is true for the caller that created the approval; it publishes the waiting status.
    Wait { approval: ApprovalId, answer: watch::Receiver<Option<Verdict>>, fresh: bool },
}

impl Chat {
    pub(crate) fn new(id: ChatId, record: ChatRecord, stored: bool, next_seq: u32) -> Self {
        let status = if stored { ChatStatus::Idle } else { ChatStatus::Draft };
        Self { id, inner: Mutex::new(ChatInner { record, stored, status, rev: 0, turn: None, closing: None, next_seq, live: BTreeMap::new(), ledger: Ledger::default(), last_context: None }) }
    }

    pub(crate) fn permission(&self) -> Permission {
        self.inner.lock().unwrap().record.options.permission
    }

    /// The one answer to "may this call run?". Idempotent per call id: the provider asks before
    /// the call and the engine asks again at execution; the second ask returns what the first
    /// recorded, and a call whose input differs from the approved one is denied.
    pub(crate) fn gate(&self, assistant: &Assistant, call: &ToolCallId, input: &Value, ask: &Ask) -> Gated {
        let mut inner = self.inner.lock().unwrap();
        match inner.ledger.calls.get(call) {
            Some(Gate::Run { input: approved }) => return if approved == input { Gated::Run } else { Gated::Deny(Refusal::Mismatch) },
            Some(Gate::Denied { why }) => return Gated::Deny(why.clone()),
            Some(Gate::Pending { approval, answer, .. }) => return Gated::Wait { approval: *approval, answer: answer.subscribe(), fresh: false },
            None => {}
        }
        match ask {
            Ask::Allow => {
                inner.ledger.calls.insert(call.clone(), Gate::Run { input: input.clone() });
                Gated::Run
            }
            Ask::Refuse(message) => {
                let why = Refusal::Policy(message.clone());
                inner.ledger.calls.insert(call.clone(), Gate::Denied { why: why.clone() });
                Gated::Deny(why)
            }
            Ask::User(_) => {
                let approval = assistant.next_approval();
                let (answer, receiver) = watch::channel(None);
                inner.ledger.calls.insert(call.clone(), Gate::Pending { approval, input: input.clone(), answer });
                Gated::Wait { approval, answer: receiver, fresh: true }
            }
        }
    }

    /// The user's answer. Made under the lock, so a second answer, an answer after Stop, and
    /// another chat's id all find nothing and get `NotPending`.
    pub(crate) fn answer(&self, approval: ApprovalId, decision: Decision) -> Result<(), ApproveError> {
        let mut inner = self.inner.lock().unwrap();
        let call = inner.ledger.calls.iter().find(|(_, g)| matches!(g, Gate::Pending { approval: a, .. } if *a == approval)).map(|(c, _)| c.clone()).ok_or(ApproveError::NotPending)?;
        let verdict = match decision {
            Decision::Run => Ok(()),
            Decision::Deny => Err(Refusal::Declined),
        };
        inner.ledger.decide(&call, verdict);
        Ok(())
    }

    /// Every pending call is denied for `why` and its waiter wakes. Returns the call ids.
    pub(crate) fn deny_pending(&self, why: Refusal) -> Vec<ToolCallId> {
        let mut inner = self.inner.lock().unwrap();
        let pending = inner.ledger.pending();
        for call in &pending {
            inner.ledger.decide(call, Err(why.clone()));
        }
        pending
    }

    /// The provider withdrew the call: its pending approval, if any, is denied as cancelled.
    pub(crate) fn cancel(&self, call: &ToolCallId) {
        self.inner.lock().unwrap().ledger.decide(call, Err(Refusal::Cancelled));
    }

    pub(crate) fn has_pending(&self) -> bool {
        self.inner.lock().unwrap().ledger.calls.values().any(|g| matches!(g, Gate::Pending { .. }))
    }

    /// Closes what a turn task that died before `finish` left open, as `recover` does at open:
    /// open text is done, waiting tools expire, and the turn gets an End with `outcome`. Then the
    /// chat is Idle. Only the supervisor calls this, once the task is gone, so nothing else writes.
    pub(crate) fn end_abruptly(&self, shared: &Shared, outcome: TurnOutcome) {
        let rows = {
            let mut inner = self.inner.lock().unwrap();
            if inner.deleted() || inner.turn.take().is_none() {
                return;
            }
            inner.ledger = Ledger::default();
            let mut rows = shared.store.chat_entries(self.id).unwrap_or_default();
            for (seq, live) in &inner.live {
                let row = (*seq, live.turn, live.entry.clone());
                match rows.iter_mut().find(|(s, _, _)| s == seq) {
                    Some(stored) => *stored = row,
                    None => rows.push(row),
                }
            }
            rows.sort_by_key(|(seq, _, _)| *seq);
            rows
        };
        let mut fixes = reply::recover(&rows, now_ms());
        for (_, _, entry) in &mut fixes {
            if let Entry::End { outcome: o, .. } = entry {
                *o = outcome.clone();
            }
        }
        let next_seq = fixes.iter().map(|(seq, _, _)| seq + 1).max().unwrap_or(0);
        if let Err(e) = shared.store.put_entries(self.id, &fixes) {
            eprintln!("chat {} recovery failed: {e}", self.id.0);
        }
        for (seq, turn, entry) in fixes {
            self.publish_entry(shared, seq, turn, entry);
        }
        {
            let mut inner = self.inner.lock().unwrap();
            inner.next_seq = inner.next_seq.max(next_seq);
            inner.record.entry_count = inner.next_seq;
            inner.record.updated_at_ms = now_ms();
            inner.status = ChatStatus::Idle;
            inner.live.clear();
        }
        self.store_record(shared);
        self.publish_state(shared);
    }

    /// Bumps the engine-wide rev, keeps the snapshot in `live`, emits `ChatEntryChanged`.
    pub(crate) fn publish_entry(&self, shared: &Shared, seq: u32, turn: u32, entry: Entry) {
        let snapshot = EntrySnapshot { chat_id: self.id, seq, rev: shared.next_chat_rev(), turn, entry };
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.deleted() {
                return;
            }
            inner.live.insert(seq, snapshot.clone());
        }
        shared.emit(AppEvent::ChatEntryChanged(snapshot));
    }

    /// Writes the row when the chat is stored. A draft stores nothing.
    pub(crate) fn store_entry(&self, shared: &Shared, seq: u32, turn: u32, entry: &Entry) {
        {
            let inner = self.inner.lock().unwrap();
            if !inner.stored || inner.deleted() {
                return;
            }
        }
        if let Err(e) = shared.store.put_entry(self.id, seq, turn, entry) {
            eprintln!("chat {} entry {seq} save failed: {e}", self.id.0);
        }
    }

    pub(crate) fn store_record(&self, shared: &Shared) {
        let (stored, record) = {
            let inner = self.inner.lock().unwrap();
            (inner.stored && !inner.deleted(), inner.record.clone())
        };
        if stored && let Err(e) = shared.store.put_chat(self.id, &record) {
            eprintln!("chat {} save failed: {e}", self.id.0);
        }
    }

    /// Mints the chat's next rev and emits `ChatChanged`. A deleted chat's one tombstone comes
    /// from `assistant_delete`; nothing is emitted for it here.
    pub(crate) fn publish_state(&self, shared: &Shared) -> ChatState {
        let (state, emit) = {
            let mut inner = self.inner.lock().unwrap();
            let emit = !inner.deleted();
            if emit {
                inner.rev = shared.next_chat_rev();
            }
            (Self::state_of(self.id, &inner), emit)
        };
        if emit {
            shared.emit(AppEvent::ChatChanged(state.clone()));
        }
        state
    }

    pub(crate) fn state(&self) -> ChatState {
        Self::state_of(self.id, &self.inner.lock().unwrap())
    }

    pub(crate) fn state_of(id: ChatId, inner: &ChatInner) -> ChatState {
        ChatState { id, rev: inner.rev, title: inner.record.title.clone(), updated_at_ms: inner.record.updated_at_ms, options: inner.record.options.clone(), status: inner.status.clone(), entry_count: inner.next_seq }
    }
}

/// A waiter treats a dropped sender (the turn ended) as expired.
pub(crate) async fn wait(mut answer: watch::Receiver<Option<Verdict>>) -> Verdict {
    match answer.wait_for(Option::is_some).await {
        Ok(verdict) => verdict.clone().expect("wait_for returns a Some"),
        Err(_) => Err(Refusal::Expired),
    }
}

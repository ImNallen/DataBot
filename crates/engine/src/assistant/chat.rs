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

const CLOSING_WAIT: Duration = Duration::from_secs(CLOSE_GRACE.as_secs() + 1);

pub(crate) struct Chat {
    pub id: ChatId,
    pub inner: Mutex<ChatInner>,
}

pub(crate) struct ChatInner {
    pub record: ChatRecord,
    pub stored: bool,
    pub status: ChatStatus,
    pub rev: u64,
    pub turn: Option<ActiveTurn>,
    pub closing: Option<Closing>,
    pub next_seq: u32,
    pub live: BTreeMap<u32, EntrySnapshot>,
    pub ledger: Ledger,
    pub last_context: Option<LastContext>,
}

impl ChatInner {
    pub(super) fn deleted(&self) -> bool {
        self.status == ChatStatus::Deleted
    }
}

pub(crate) struct ActiveTurn {
    pub db: Option<DatabaseRef>,
    pub control: mpsc::Sender<TurnControl>,
    pub supervisor: Option<JoinHandle<()>>,
    pub abort: Option<AbortHandle>,
}

pub(crate) enum TurnControl {
    Stop { grace: Duration },
}

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

#[derive(Default)]
pub(crate) struct Ledger {
    calls: HashMap<ToolCallId, Gate>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Refusal {
    Policy(String),
    Declined,
    Stopped,
    Cancelled,
    Expired,
    Mismatch,
}

type Verdict = Result<(), Refusal>;

enum Gate {
    Pending { approval: ApprovalId, input: Value, answer: watch::Sender<Option<Verdict>> },
    Run { input: Value },
    Denied { why: Refusal },
}

impl Ledger {
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
    Wait { approval: ApprovalId, answer: watch::Receiver<Option<Verdict>>, created_here: bool },
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
            Some(Gate::Pending { approval, answer, .. }) => return Gated::Wait { approval: *approval, answer: answer.subscribe(), created_here: false },
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
                Gated::Wait { approval, answer: receiver, created_here: true }
            }
        }
    }

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

    pub(crate) fn deny_pending(&self, why: Refusal) -> Vec<ToolCallId> {
        let mut inner = self.inner.lock().unwrap();
        let pending = inner.ledger.pending();
        for call in &pending {
            inner.ledger.decide(call, Err(why.clone()));
        }
        pending
    }

    pub(crate) fn cancel(&self, call: &ToolCallId) {
        self.inner.lock().unwrap().ledger.decide(call, Err(Refusal::Cancelled));
    }

    pub(crate) fn has_pending(&self) -> bool {
        self.inner.lock().unwrap().ledger.calls.values().any(|g| matches!(g, Gate::Pending { .. }))
    }

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

pub(crate) async fn wait(mut answer: watch::Receiver<Option<Verdict>>) -> Verdict {
    match answer.wait_for(Option::is_some).await {
        Ok(verdict) => verdict.clone().expect("wait_for returns a Some"),
        Err(_) => Err(Refusal::Expired),
    }
}

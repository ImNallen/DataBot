//! One chat: its stored record, the running turn's slot, the approval ledger, and publishing.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use super::Assistant;
use super::tools::Ask;
use crate::Shared;
use crate::model::{AppEvent, ApprovalId, ApproveError, ChatId, ChatState, ChatStatus, DatabaseRef, Decision, Entry, EntrySnapshot, Permission, ToolCallId};
use crate::store::ChatRecord;

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
    /// Entries are numbered `0..next_seq`; the record's `entry_count` catches up at turn end.
    pub next_seq: u32,
    /// Snapshots the running turn published, keyed by seq. `open` overlays them on the stored rows.
    pub live: BTreeMap<u32, EntrySnapshot>,
    pub ledger: Ledger,
    /// What the last message to the current provider session carried. Memory only: catalog
    /// versions restart with the engine.
    pub last_context: Option<LastContext>,
}

/// The turn task owns the process; this is what the rest of the engine sees of it.
pub(crate) struct ActiveTurn {
    pub db: Option<DatabaseRef>,
    pub control: mpsc::Sender<TurnControl>,
    pub task: Option<JoinHandle<()>>,
}

pub(crate) enum TurnControl {
    /// Deny pending approvals, cancel running tools, interrupt, and kill after `grace`.
    Stop { grace: Duration },
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

enum Gate {
    Pending { approval: ApprovalId, input: Value, answer: watch::Sender<Option<Decision>> },
    Decided { input: Value, decision: Decision },
}

pub(crate) enum Gated {
    Decided(Decision),
    /// `fresh` is true for the caller that created the approval; it publishes the waiting status.
    Wait { approval: ApprovalId, answer: watch::Receiver<Option<Decision>>, fresh: bool },
}

impl Chat {
    pub(crate) fn new(id: ChatId, record: ChatRecord, stored: bool, next_seq: u32) -> Self {
        let status = if stored { ChatStatus::Idle } else { ChatStatus::Draft };
        Self { id, inner: Mutex::new(ChatInner { record, stored, status, rev: 0, turn: None, next_seq, live: BTreeMap::new(), ledger: Ledger::default(), last_context: None }) }
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
            Some(Gate::Decided { input: approved, decision }) => return Gated::Decided(if approved == input { *decision } else { Decision::Deny }),
            Some(Gate::Pending { approval, answer, .. }) => return Gated::Wait { approval: *approval, answer: answer.subscribe(), fresh: false },
            None => {}
        }
        match ask {
            Ask::Allow => {
                inner.ledger.calls.insert(call.clone(), Gate::Decided { input: input.clone(), decision: Decision::Run });
                Gated::Decided(Decision::Run)
            }
            Ask::Refuse(_) => {
                inner.ledger.calls.insert(call.clone(), Gate::Decided { input: input.clone(), decision: Decision::Deny });
                Gated::Decided(Decision::Deny)
            }
            Ask::User(_) => {
                let approval = assistant.next_approval();
                let (answer, receiver) = watch::channel(None);
                inner.ledger.calls.insert(call.clone(), Gate::Pending { approval, input: input.clone(), answer });
                Gated::Wait { approval, answer: receiver, fresh: true }
            }
        }
    }

    /// The only transition out of `Pending`, made under the lock, so a second answer, an answer
    /// after Stop, and another chat's id all find nothing and get `NotPending`.
    pub(crate) fn answer(&self, approval: ApprovalId, decision: Decision) -> Result<(), ApproveError> {
        let mut inner = self.inner.lock().unwrap();
        let call = inner.ledger.calls.iter().find(|(_, g)| matches!(g, Gate::Pending { approval: a, .. } if *a == approval)).map(|(c, _)| c.clone()).ok_or(ApproveError::NotPending)?;
        let Some(Gate::Pending { input, answer, .. }) = inner.ledger.calls.remove(&call) else { unreachable!("found above") };
        inner.ledger.calls.insert(call, Gate::Decided { input, decision });
        let _ = answer.send(Some(decision));
        Ok(())
    }

    /// Every Pending becomes Decided(Deny) and its waiter wakes. Returns the call ids.
    pub(crate) fn deny_pending(&self) -> Vec<ToolCallId> {
        let mut inner = self.inner.lock().unwrap();
        let pending: Vec<ToolCallId> = inner.ledger.calls.iter().filter(|(_, g)| matches!(g, Gate::Pending { .. })).map(|(c, _)| c.clone()).collect();
        for call in &pending {
            if let Some(Gate::Pending { input, answer, .. }) = inner.ledger.calls.remove(call) {
                inner.ledger.calls.insert(call.clone(), Gate::Decided { input, decision: Decision::Deny });
                let _ = answer.send(Some(Decision::Deny));
            }
        }
        pending
    }

    pub(crate) fn has_pending(&self) -> bool {
        self.inner.lock().unwrap().ledger.calls.values().any(|g| matches!(g, Gate::Pending { .. }))
    }

    /// Bumps the engine-wide rev, keeps the snapshot in `live`, emits `ChatEntryChanged`.
    pub(crate) fn publish_entry(&self, shared: &Shared, seq: u32, turn: u32, entry: Entry) {
        let snapshot = EntrySnapshot { chat_id: self.id, seq, rev: shared.next_chat_rev(), turn, entry };
        self.inner.lock().unwrap().live.insert(seq, snapshot.clone());
        shared.emit(AppEvent::ChatEntryChanged(snapshot));
    }

    /// Writes the row when the chat is stored. A draft stores nothing.
    pub(crate) fn store_entry(&self, shared: &Shared, seq: u32, turn: u32, entry: &Entry) {
        if !self.inner.lock().unwrap().stored {
            return;
        }
        if let Err(e) = shared.store.put_entry(self.id, seq, turn, entry) {
            eprintln!("chat {} entry {seq} save failed: {e}", self.id.0);
        }
    }

    pub(crate) fn store_record(&self, shared: &Shared) {
        let (stored, record) = {
            let inner = self.inner.lock().unwrap();
            (inner.stored, inner.record.clone())
        };
        if stored && let Err(e) = shared.store.put_chat(self.id, &record) {
            eprintln!("chat {} save failed: {e}", self.id.0);
        }
    }

    pub(crate) fn publish_state(&self, shared: &Shared) -> ChatState {
        let state = {
            let mut inner = self.inner.lock().unwrap();
            inner.rev = shared.next_chat_rev();
            Self::state_of(self.id, &inner)
        };
        shared.emit(AppEvent::ChatChanged(state.clone()));
        state
    }

    pub(crate) fn state(&self) -> ChatState {
        Self::state_of(self.id, &self.inner.lock().unwrap())
    }

    fn state_of(id: ChatId, inner: &ChatInner) -> ChatState {
        ChatState { id, rev: inner.rev, title: inner.record.title.clone(), updated_at_ms: inner.record.updated_at_ms, options: inner.record.options.clone(), status: inner.status.clone(), entry_count: inner.next_seq }
    }
}

/// A waiter treats a dropped sender (the turn ended) as Deny.
pub(crate) async fn wait(mut answer: watch::Receiver<Option<Decision>>) -> Decision {
    match answer.wait_for(Option::is_some).await {
        Ok(decision) => decision.unwrap_or(Decision::Deny),
        Err(_) => Decision::Deny,
    }
}

//! The assistant through the public `Engine`, with `fake-claude` standing in for the CLI. The fake
//! is selected the way a user would select a binary: `binaryPath` and `launchArgs` in Settings.

use std::sync::Arc;
use std::time::{Duration, Instant};

use engine::model::*;
use engine::{Engine, EngineConfig, MemoryKeyStore};
use tokio::sync::broadcast;

const FAKE: &str = env!("CARGO_BIN_EXE_fake-claude");
const WAIT: Duration = Duration::from_secs(30);

struct Harness {
    engine: Arc<Engine>,
    events: broadcast::Receiver<AppEvent>,
    dir: tempfile::TempDir,
}

impl Harness {
    async fn open() -> Self {
        Self::open_in(tempfile::tempdir().unwrap()).await
    }

    async fn open_in(dir: tempfile::TempDir) -> Self {
        let engine = Engine::open(EngineConfig { data_dir: dir.path().join("data"), keys: Arc::new(MemoryKeyStore::default()) }).await.unwrap();
        let events = engine.subscribe();
        Self { engine, events, dir }
    }

    fn log_path(&self) -> std::path::PathBuf {
        self.dir.path().join("fake.log")
    }

    /// Points the provider at the fake with `scenario`, which re-probes it.
    fn use_fake(&self, scenario: &str) {
        self.configure_provider(|p| {
            p.binary_path = FAKE.into();
            p.launch_args = format!("--fake-scenario {scenario} --fake-log {}", self.log_path().display());
        });
    }

    fn configure_provider(&self, edit: impl FnOnce(&mut ProviderConfig)) {
        let mut settings = self.engine.settings();
        edit(&mut settings.providers[0]);
        self.engine.set_settings(settings);
    }

    async fn wait_event(&mut self, what: &str, mut pick: impl FnMut(&AppEvent) -> bool) -> AppEvent {
        let started = Instant::now();
        loop {
            let remaining = WAIT.checked_sub(started.elapsed()).unwrap_or_else(|| panic!("timed out waiting for {what}"));
            match tokio::time::timeout(remaining, self.events.recv()).await {
                Ok(Ok(event)) if pick(&event) => return event,
                Ok(Ok(_)) => {}
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => {}
                Ok(Err(e)) => panic!("{e}"),
                Err(_) => panic!("timed out waiting for {what}"),
            }
        }
    }

    async fn wait_provider(&mut self, what: &str, done: impl Fn(&ProviderState) -> bool) -> ProviderState {
        match self.wait_event(what, |e| matches!(e, AppEvent::ProviderChanged(s) if done(s))).await {
            AppEvent::ProviderChanged(state) => state,
            _ => unreachable!(),
        }
    }

    /// A finished probe whose outcome came from the fake, not from a real CLI on this machine,
    /// with no further probe running: a settings change that lands while the open-time probe is
    /// still pending owes one more probe, and the gate runs it right after.
    async fn wait_fake_outcome(&mut self, done: impl Fn(&ProbeOutcome) -> bool) -> ProbeOutcome {
        self.wait_provider("a probe outcome", |s| !s.checking && s.outcome.as_ref().is_some_and(&done)).await;
        self.settle().await.outcome.unwrap()
    }

    async fn settle(&mut self) -> ProviderState {
        loop {
            let state = self.engine.boot().providers.into_iter().next().unwrap();
            if !state.checking {
                return state;
            }
            self.wait_provider("the owed probe", |s| !s.checking).await;
        }
    }

    fn log(&self) -> String {
        std::fs::read_to_string(self.log_path()).unwrap_or_default()
    }

    fn handshakes(&self) -> usize {
        self.log().lines().filter(|l| l.starts_with("argv\t")).count()
    }

    /// The pid and argv of each turn process, in order. A probe's handshake carries no `--model`.
    fn turns(&self) -> Vec<(u32, Vec<String>)> {
        self.log()
            .lines()
            .filter_map(|l| l.strip_prefix("argv\t")?.split_once('\t'))
            .map(|(pid, argv)| (pid.parse().unwrap(), serde_json::from_str::<Vec<String>>(argv).unwrap()))
            .filter(|(_, argv)| argv.iter().any(|x| x == "--model"))
            .collect()
    }

    fn turn_argvs(&self) -> Vec<Vec<String>> {
        self.turns().into_iter().map(|(_, argv)| argv).collect()
    }

    fn turn_pids(&self) -> Vec<u32> {
        self.turns().into_iter().map(|(pid, _)| pid).collect()
    }

    fn stdin_lines(&self) -> Vec<String> {
        self.log().lines().filter_map(|l| l.strip_prefix("stdin\t")).map(str::to_owned).collect()
    }

    fn chat(&self, permission: Permission) -> ChatId {
        let id = ChatId(uuid::Uuid::new_v4());
        let options = ChatOptions { provider: ProviderKind::Claude, model: ModelId("opus".into()), effort: Some(EffortId("high".into())), permission };
        self.engine.assistant_configure(id, options).unwrap();
        id
    }

    async fn send(&self, chat: ChatId, text: &str) -> TurnAccepted {
        self.engine.assistant_send(chat, SendRequest { text: text.into(), tab: None }).await.unwrap()
    }

    async fn wait_entry(&mut self, chat: ChatId, what: &str, pick: impl Fn(&EntrySnapshot) -> bool) -> EntrySnapshot {
        match self.wait_event(what, |e| matches!(e, AppEvent::ChatEntryChanged(s) if s.chat_id == chat && pick(s))).await {
            AppEvent::ChatEntryChanged(snapshot) => snapshot,
            _ => unreachable!(),
        }
    }

    async fn wait_end(&mut self, chat: ChatId) -> (TurnOutcome, Vec<String>) {
        let snapshot = self.wait_entry(chat, "the End entry", |s| matches!(s.entry, Entry::End { .. })).await;
        let Entry::End { outcome, suggestions, .. } = snapshot.entry else { unreachable!() };
        (outcome, suggestions)
    }

    async fn wait_approval(&mut self, chat: ChatId) -> (ApprovalId, ApprovalReason) {
        let snapshot = self.wait_entry(chat, "an approval", |s| matches!(s.entry, Entry::Tool { status: ToolStatus::AwaitingApproval { .. }, .. })).await;
        let Entry::Tool { status: ToolStatus::AwaitingApproval { approval, reason }, .. } = snapshot.entry else { unreachable!() };
        (approval, reason)
    }

    async fn wait_chat(&mut self, chat: ChatId, what: &str, pick: impl Fn(&ChatState) -> bool) -> ChatState {
        match self.wait_event(what, |e| matches!(e, AppEvent::ChatChanged(s) if s.id == chat && pick(s))).await {
            AppEvent::ChatChanged(state) => state,
            _ => unreachable!(),
        }
    }

    async fn entries(&self, chat: ChatId) -> Vec<Entry> {
        self.engine.assistant_open(chat).await.unwrap().entries.into_iter().map(|s| s.entry).collect()
    }
}

fn lists_the_fake_model(outcome: &ProbeOutcome) -> bool {
    matches!(outcome, ProbeOutcome::Ready { models, .. } if models.iter().any(|m| m.id.0 == "fake"))
}

fn alive(pid: u32) -> bool {
    std::process::Command::new("kill").args(["-0", &pid.to_string()]).stderr(std::process::Stdio::null()).status().unwrap().success()
}

async fn wait_dead(pid: u32) {
    let started = Instant::now();
    while alive(pid) {
        assert!(started.elapsed() < Duration::from_secs(10), "process {pid} is still alive");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn text_of(entry: &Entry) -> String {
    let Entry::Text { blocks, .. } = entry else { return String::new() };
    blocks
        .iter()
        .map(|b| match b {
            ReplyBlock::Markdown { text } => text.clone(),
            ReplyBlock::Sql { sql, .. } => sql.clone(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[tokio::test]
async fn the_probe_reads_version_plan_and_models_and_boot_carries_them() {
    let mut h = Harness::open().await;
    h.use_fake("none");
    let outcome = h.wait_fake_outcome(lists_the_fake_model).await;
    let ProbeOutcome::Ready { version, plan, models } = outcome else { panic!("{outcome:?}") };
    assert_eq!((version.as_str(), plan.as_deref()), ("2.1.301", Some("Claude Max")));
    assert_eq!(models.iter().map(|m| m.id.0.as_str()).collect::<Vec<_>>(), ["opus", "fable", "sonnet", "haiku", "fake"], "the default alias is hidden");
    assert_eq!(models.iter().filter(|m| m.recommended).map(|m| m.label.as_str()).collect::<Vec<_>>(), ["Opus 5.5"]);
    assert_eq!(models[0].efforts.iter().map(|e| e.label.as_str()).collect::<Vec<_>>(), ["Low", "Medium", "High", "Extra high", "Max"]);
    assert!(models[4].efforts.is_empty());
    let booted = h.engine.boot().providers;
    assert_eq!(booted.len(), 1);
    assert_eq!((booted[0].provider, booted[0].info.default_binary.as_str(), booted[0].checking), (ProviderKind::Claude, "claude", false));
    assert!(matches!(&booted[0].outcome, Some(ProbeOutcome::Ready { version, .. }) if version == "2.1.301"));
    assert!(booted[0].checked_at_ms.is_some());
    let log = h.log();
    let argv = log.lines().find(|l| l.starts_with("argv\t")).unwrap();
    assert!(argv.contains("--setting-sources=") && argv.contains("--permission-prompt-tool=stdio") && !argv.contains("--resume"), "{argv}");
}

#[tokio::test]
async fn a_missing_binary_probes_not_found_and_a_signed_out_config_dir_probes_signed_out() {
    let mut h = Harness::open().await;
    h.configure_provider(|p| p.binary_path = "/nope".into());
    assert_eq!(h.wait_fake_outcome(|o| matches!(o, ProbeOutcome::NotFound { .. })).await, ProbeOutcome::NotFound { binary: "/nope".into() });
    let signed_out = h.dir.path().join("signed-out");
    std::fs::create_dir_all(&signed_out).unwrap();
    h.configure_provider(|p| {
        p.binary_path = FAKE.into();
        p.config_dir = signed_out.display().to_string();
    });
    assert_eq!(h.wait_fake_outcome(|o| matches!(o, ProbeOutcome::SignedOut { .. })).await, ProbeOutcome::SignedOut { version: "2.1.301".into() });
}

#[tokio::test]
async fn provider_refresh_works_from_a_thread_without_a_runtime_and_reprobes() {
    let mut h = Harness::open().await;
    h.use_fake("none");
    h.wait_fake_outcome(lists_the_fake_model).await;
    let (before, handshakes) = (h.settle().await, h.handshakes());
    let caller = h.engine.clone();
    std::thread::spawn(move || caller.provider_refresh()).join().expect("provider_refresh panicked off the runtime");
    let after = h.wait_provider("the refresh's outcome", |s| !s.checking && s.checked_at_ms > before.checked_at_ms).await;
    assert!(lists_the_fake_model(after.outcome.as_ref().unwrap()));
    assert_eq!(h.handshakes(), handshakes + 1, "a refresh is a full probe, so it ran the handshake once more");
}

#[tokio::test]
async fn an_unchanged_setting_does_not_reprobe_but_the_health_loop_does() {
    let mut h = Harness::open().await;
    h.use_fake("none");
    h.wait_fake_outcome(lists_the_fake_model).await;
    let (before, handshakes) = (h.settle().await, h.handshakes());
    let mut settings = h.engine.settings();
    settings.provider_health_check_secs = 1;
    h.engine.set_settings(settings);
    let after = h.wait_provider("the health loop's probe", |s| !s.checking && s.checked_at_ms > before.checked_at_ms).await;
    assert!(lists_the_fake_model(after.outcome.as_ref().unwrap()), "a quick probe keeps the models of the last full one");
    assert_eq!(h.handshakes(), handshakes, "the interval change alone re-probed nothing, and the quick probe ran no handshake");
}

#[tokio::test]
async fn a_turn_streams_the_reply_into_blocks_and_ends_with_suggestions() {
    let mut h = Harness::open().await;
    h.use_fake("card");
    let chat = h.chat(Permission::Auto);
    let accepted = h.send(chat, "Which regions grew the most compared with the 90 days before?").await;
    assert_eq!(accepted.turn, 0);
    let running = h.wait_chat(chat, "the running state", |s| matches!(s.status, ChatStatus::Running { .. })).await;
    assert_eq!(running.title, "Which regions grew the most compared with the 90 days before", "the first line, cut at 60 chars");
    let streaming = h.wait_entry(chat, "a streaming text", |s| matches!(&s.entry, Entry::Text { done: false, blocks } if !blocks.is_empty())).await;
    assert_eq!(streaming.turn, 0);
    let (outcome, suggestions) = h.wait_end(chat).await;
    assert_eq!(outcome, TurnOutcome::Completed);
    assert_eq!(suggestions, ["Show growth as a percentage", "Only EU regions"]);
    let entries = h.entries(chat).await;
    assert_eq!(entries.len(), 3, "{entries:?}");
    assert!(matches!(&entries[0], Entry::User { text, context: None, attachment: None, .. } if text.starts_with("Which regions")));
    let Entry::Text { blocks, done: true } = &entries[1] else { panic!("{:?}", entries[1]) };
    assert_eq!(blocks.len(), 3, "{blocks:?}");
    assert_eq!(blocks[0], ReplyBlock::Markdown { text: "This compares paid revenue by region over the last 90 days:".into() });
    let ReplyBlock::Sql { sql, relations, writes, complete } = &blocks[1] else { panic!("{:?}", blocks[1]) };
    assert!(sql.starts_with("select c.region") && sql.ends_with("order by revenue desc"));
    assert_eq!((relations.clone(), *writes, *complete), (vec!["orders".to_owned(), "customers".to_owned()], false, true));
    assert_eq!(blocks[2], ReplyBlock::Markdown { text: "`revenue` sums `o.total` for paid orders only.".into() });
    let idle = h.wait_chat(chat, "the idle state", |s| s.status == ChatStatus::Idle).await;
    assert_eq!(idle.entry_count, 3);
    let listed = h.engine.boot().chats;
    assert_eq!(listed.iter().map(|c| c.id).collect::<Vec<_>>(), [chat]);
    assert!(h.stdin_lines().iter().any(|l| l.contains("Which regions grew") && l.contains("<l1_context>")), "the prompt carries the context block");
}

#[tokio::test]
async fn a_second_send_during_a_turn_is_busy() {
    let mut h = Harness::open().await;
    h.use_fake("slow");
    let chat = h.chat(Permission::Auto);
    h.send(chat, "one").await;
    h.wait_entry(chat, "streaming text", |s| matches!(s.entry, Entry::Text { .. })).await;
    assert_eq!(h.engine.assistant_send(chat, SendRequest { text: "two".into(), tab: None }).await.unwrap_err(), SendError::Busy);
    h.engine.assistant_stop(chat);
    assert_eq!(h.wait_end(chat).await.0, TurnOutcome::Stopped);
    assert_eq!(h.send(chat, "two").await.turn, 3, "a new turn is accepted once the old one ended");
    h.wait_entry(chat, "the second turn's text", |s| s.turn == 3 && matches!(s.entry, Entry::Text { .. })).await;
    h.engine.assistant_stop(chat);
    assert_eq!(h.wait_end(chat).await.0, TurnOutcome::Stopped);
}

#[tokio::test]
async fn ask_first_waits_for_the_user_then_runs_once_and_a_second_answer_is_not_pending() {
    let mut h = Harness::open().await;
    h.use_fake("query");
    let chat = h.chat(Permission::AskFirst);
    h.send(chat, "How many orders?").await;
    let (approval, reason) = h.wait_approval(chat).await;
    assert_eq!(reason, ApprovalReason::AskFirst);
    let waiting = h.wait_chat(chat, "the waiting phase", |s| matches!(s.status, ChatStatus::Running { phase: TurnPhase::AwaitingApproval, .. })).await;
    assert_eq!(waiting.entry_count, 2);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!h.stdin_lines().iter().any(|l| l.contains("\"behavior\"")), "nothing was answered before the user did");
    assert_eq!(h.engine.assistant_approve(chat, approval, Decision::Run), Ok(()));
    assert_eq!(h.engine.assistant_approve(chat, approval, Decision::Run), Err(ApproveError::NotPending));
    assert_eq!(h.wait_end(chat).await.0, TurnOutcome::Completed);
    let entries = h.entries(chat).await;
    let Entry::Tool { tool, status, .. } = &entries[1] else { panic!("{:?}", entries[1]) };
    assert_eq!(tool, &ToolUse::RunQuery { sql: "select count(*) from orders".into(), purpose: "Count the orders".into(), relations: vec!["orders".into()] });
    assert_eq!(status, &ToolStatus::Failed { message: "No database is selected. Ask the user to open a tab on a connection.".into() }, "the call ran: without a database it fails there, not at the gate");
    assert!(text_of(&entries[2]).contains("The tool failed: No database is selected"));
    let allows: Vec<String> = h.stdin_lines().into_iter().filter(|l| l.contains("\"behavior\":\"allow\"")).collect();
    assert_eq!(allows.len(), 1);
    assert!(allows[0].contains("\"updatedInput\":{\"purpose\":\"Count the orders\",\"sql\":\"select count(*) from orders\"}"), "{}", allows[0]);
    assert_eq!(h.engine.assistant_approve(chat, approval, Decision::Deny), Err(ApproveError::NotPending), "answered turns stay answered");
}

#[tokio::test]
async fn deny_reaches_the_model_as_an_error_result() {
    let mut h = Harness::open().await;
    h.use_fake("query");
    let chat = h.chat(Permission::AskFirst);
    h.send(chat, "How many orders?").await;
    let (approval, _) = h.wait_approval(chat).await;
    assert_eq!(h.engine.assistant_approve(chat, approval, Decision::Deny), Ok(()));
    assert_eq!(h.wait_end(chat).await.0, TurnOutcome::Completed);
    let entries = h.entries(chat).await;
    assert!(matches!(&entries[1], Entry::Tool { status: ToolStatus::Denied { stopped: false }, .. }), "{:?}", entries[1]);
    assert!(text_of(&entries[2]).contains("The call was declined: The user declined this tool call."), "{}", text_of(&entries[2]));
    assert!(h.stdin_lines().iter().any(|l| l.contains("\"behavior\":\"deny\"") && l.contains("The user declined this tool call.")));
    assert!(!h.stdin_lines().iter().any(|l| l.contains("tools/call") || l.contains("mcp_response\":{\"id\":2")), "no call ran");
}

#[tokio::test]
async fn a_tools_call_whose_arguments_differ_from_the_approved_input_is_refused() {
    let mut h = Harness::open().await;
    h.use_fake("query-tampered");
    let chat = h.chat(Permission::Auto);
    h.send(chat, "How many orders?").await;
    assert_eq!(h.wait_end(chat).await.0, TurnOutcome::Completed);
    let entries = h.entries(chat).await;
    assert!(matches!(&entries[1], Entry::Tool { status: ToolStatus::Failed { message }, .. } if message == "This call was not approved."), "{:?}", entries[1]);
    assert!(text_of(&entries[2]).contains("The tool failed: This call was not approved."));
    assert!(h.stdin_lines().iter().any(|l| l.contains("\"isError\":true") && l.contains("This call was not approved.")));
}

#[tokio::test]
async fn auto_runs_a_read_query_without_asking() {
    let mut h = Harness::open().await;
    h.use_fake("query");
    let chat = h.chat(Permission::Auto);
    h.send(chat, "How many orders?").await;
    assert_eq!(h.wait_end(chat).await.0, TurnOutcome::Completed);
    let entries = h.entries(chat).await;
    assert!(matches!(&entries[1], Entry::Tool { status: ToolStatus::Failed { message }, .. } if message.starts_with("No database is selected")), "{:?}", entries[1]);
    assert!(h.stdin_lines().iter().any(|l| l.contains("\"behavior\":\"allow\"")));
    let states: Vec<Entry> = entries;
    assert!(!states.iter().any(|e| matches!(e, Entry::Tool { status: ToolStatus::AwaitingApproval { .. }, .. })));
}

#[tokio::test]
async fn stop_ends_the_turn_stopped_and_the_process_is_gone() {
    let mut h = Harness::open().await;
    h.use_fake("slow");
    let chat = h.chat(Permission::Auto);
    h.send(chat, "go").await;
    h.wait_entry(chat, "streaming text", |s| matches!(&s.entry, Entry::Text { done: false, blocks } if !blocks.is_empty())).await;
    let pid = h.turn_pids()[0];
    assert!(alive(pid));
    let caller = h.engine.clone();
    std::thread::spawn(move || caller.assistant_stop(chat)).join().expect("assistant_stop panicked off the runtime");
    let (outcome, suggestions) = h.wait_end(chat).await;
    assert_eq!((outcome, suggestions), (TurnOutcome::Stopped, Vec::new()));
    wait_dead(pid).await;
    let entries = h.entries(chat).await;
    assert!(matches!(&entries[1], Entry::Text { done: true, blocks } if text_of(&entries[1]).starts_with("tick 1 ") && !blocks.is_empty()), "{:?}", entries[1]);
    assert!(h.stdin_lines().iter().any(|l| l.contains("\"subtype\":\"interrupt\"")));
    h.engine.assistant_stop(chat);
}

#[tokio::test]
async fn a_crash_ends_the_turn_failed_with_the_stderr_tail() {
    let mut h = Harness::open().await;
    h.use_fake("crash");
    let chat = h.chat(Permission::Auto);
    h.send(chat, "go").await;
    let (outcome, _) = h.wait_end(chat).await;
    let TurnOutcome::Failed { error: AgentError::Exited { code, detail } } = outcome else { panic!("{outcome:?}") };
    assert_eq!(code, Some(1));
    assert!(detail.contains("fake-claude: simulated crash"), "{detail}");
    let entries = h.entries(chat).await;
    assert_eq!(text_of(&entries[1]), "Working on it");
    assert_eq!(h.wait_chat(chat, "idle", |s| s.status == ChatStatus::Idle).await.entry_count, 3);
}

#[tokio::test]
async fn a_lost_session_falls_back_to_a_new_one_with_a_notice_and_a_recap() {
    let mut h = Harness::open().await;
    h.use_fake("resume-lost");
    let chat = h.chat(Permission::Auto);
    h.send(chat, "first").await;
    assert_eq!(h.wait_end(chat).await.0, TurnOutcome::Completed);
    let first_session = format!("fake-session-{}", h.turn_pids()[0]);
    h.send(chat, "second").await;
    assert_eq!(h.wait_end(chat).await.0, TurnOutcome::Completed);
    let argvs = h.turn_argvs();
    assert_eq!(argvs.len(), 3, "first turn, the failed resume, the retry: {argvs:?}");
    assert_eq!(argvs[1].iter().position(|a| a == "--resume").map(|i| argvs[1][i + 1].as_str()), Some(first_session.as_str()));
    assert!(!argvs[2].iter().any(|a| a == "--resume"));
    let entries = h.entries(chat).await;
    let notice = entries.iter().find_map(|e| match e {
        Entry::Notice { text } => Some(text.clone()),
        _ => None,
    });
    assert_eq!(notice.as_deref(), Some("Claude could not resume this chat, so it was restarted with a summary of the conversation."));
    assert!(h.stdin_lines().iter().any(|l| l.contains("Earlier in this conversation, restored after the session was lost") && l.contains("User: first")), "the retry's prompt carries the recap");
    h.send(chat, "third").await;
    assert_eq!(h.wait_end(chat).await.0, TurnOutcome::Completed);
    let argvs = h.turn_argvs();
    assert_eq!(argvs[3].iter().position(|a| a == "--resume").map(|i| argvs[3][i + 1].clone()), Some(format!("fake-session-{}", h.turn_pids()[2])), "the next turn resumes the replacement session");
}

#[tokio::test]
async fn a_changed_config_dir_restarts_the_session_with_a_recap() {
    let mut h = Harness::open().await;
    h.use_fake("card");
    let chat = h.chat(Permission::Auto);
    h.send(chat, "first").await;
    assert_eq!(h.wait_end(chat).await.0, TurnOutcome::Completed);
    let other = h.dir.path().join("other-config");
    std::fs::create_dir_all(&other).unwrap();
    h.configure_provider(|p| p.config_dir = other.display().to_string());
    h.send(chat, "second").await;
    assert_eq!(h.wait_end(chat).await.0, TurnOutcome::Completed);
    let argvs = h.turn_argvs();
    assert_eq!(argvs.len(), 2, "no resume was attempted: {argvs:?}");
    assert!(!argvs[1].iter().any(|a| a == "--resume"));
    let entries = h.entries(chat).await;
    assert!(entries.iter().any(|e| matches!(e, Entry::Notice { text } if text.starts_with("Claude could not resume this chat"))), "{entries:?}");
    assert!(h.stdin_lines().iter().any(|l| l.contains("Earlier in this conversation, restored after the session was lost") && l.contains("User: first")));
    h.send(chat, "third").await;
    assert_eq!(h.wait_end(chat).await.0, TurnOutcome::Completed);
    let argvs = h.turn_argvs();
    assert_eq!(argvs[2].iter().position(|a| a == "--resume").map(|i| argvs[2][i + 1].clone()), Some(format!("fake-session-{}", h.turn_pids()[1])), "the replacement session resumes under the new config dir");
}

#[tokio::test]
async fn the_second_turn_resumes_the_session_and_a_changed_model_reaches_argv() {
    let mut h = Harness::open().await;
    h.use_fake("card");
    let chat = h.chat(Permission::Auto);
    h.send(chat, "one").await;
    assert_eq!(h.wait_end(chat).await.0, TurnOutcome::Completed);
    let first = h.turn_argvs()[0].clone();
    assert!(!first.iter().any(|a| a == "--resume"));
    assert_eq!(first.iter().position(|a| a == "--model").map(|i| first[i + 1].as_str()), Some("opus"));
    assert_eq!(first.iter().position(|a| a == "--effort").map(|i| first[i + 1].as_str()), Some("high"));
    let state = h.engine.assistant_configure(chat, ChatOptions { provider: ProviderKind::Claude, model: ModelId("sonnet".into()), effort: Some(EffortId("low".into())), permission: Permission::Auto }).unwrap();
    assert_eq!(state.options.model, ModelId("sonnet".into()));
    h.send(chat, "two").await;
    assert_eq!(h.wait_end(chat).await.0, TurnOutcome::Completed);
    let second = h.turn_argvs()[1].clone();
    assert_eq!(second.iter().position(|a| a == "--resume").map(|i| second[i + 1].clone()), Some(format!("fake-session-{}", h.turn_pids()[0])));
    assert_eq!(second.iter().position(|a| a == "--model").map(|i| second[i + 1].as_str()), Some("sonnet"));
    assert_eq!(second.iter().position(|a| a == "--effort").map(|i| second[i + 1].as_str()), Some("low"));
    let entries = h.entries(chat).await;
    assert_eq!(entries.len(), 6);
    assert!(matches!(&entries[3], Entry::User { text, .. } if text == "two"));
}

#[tokio::test]
async fn chats_persist_across_open_and_a_mid_turn_row_recovers_as_lost() {
    let dir = tempfile::tempdir().unwrap();
    let chat = ChatId(uuid::Uuid::new_v4());
    {
        let mut h = Harness::open_in(dir).await;
        h.use_fake("card");
        h.engine.assistant_configure(chat, ChatOptions { provider: ProviderKind::Claude, model: ModelId("opus".into()), effort: None, permission: Permission::Auto }).unwrap();
        h.send(chat, "persist me").await;
        assert_eq!(h.wait_end(chat).await.0, TurnOutcome::Completed);
        h.engine.shutdown().await;
        let h2 = Harness::open_in(h.dir).await;
        let listed = h2.engine.boot().chats;
        assert_eq!(listed.iter().map(|c| (c.id, c.title.as_str(), c.entry_count)).collect::<Vec<_>>(), [(chat, "persist me", 3)]);
        let entries = h2.entries(chat).await;
        assert!(matches!(&entries[0], Entry::User { text, .. } if text == "persist me"));
        assert!(matches!(&entries[1], Entry::Text { done: true, .. }));
        assert!(matches!(&entries[2], Entry::End { outcome: TurnOutcome::Completed, .. }));
        drop(h2);
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_owned();
    let lost = ChatId(uuid::Uuid::new_v4());
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let mut h = Harness::open_in(tempfile::TempDir::new_in(&path).unwrap()).await;
            h.use_fake("slow");
            h.engine.assistant_configure(lost, ChatOptions { provider: ProviderKind::Claude, model: ModelId("opus".into()), effort: None, permission: Permission::Auto }).unwrap();
            h.send(lost, "lose me").await;
            h.wait_entry(lost, "streaming text", |s| matches!(s.entry, Entry::Text { .. })).await;
            std::mem::forget(h.dir);
            std::fs::write(path.join("data-dir"), h.engine.data_dir().display().to_string()).unwrap();
        });
        rt.shutdown_background();
    })
    .join()
    .unwrap();
    let data_dir = std::fs::read_to_string(dir.path().join("data-dir")).unwrap();
    let engine = Engine::open(EngineConfig { data_dir: data_dir.into(), keys: Arc::new(MemoryKeyStore::default()) }).await.unwrap();
    let listed = engine.boot().chats;
    assert_eq!(listed.iter().map(|c| (c.id, c.status.clone())).collect::<Vec<_>>(), [(lost, ChatStatus::Idle)]);
    let view = engine.assistant_open(lost).await.unwrap();
    let entries: Vec<Entry> = view.entries.into_iter().map(|s| s.entry).collect();
    assert_eq!(entries.len(), 2, "{entries:?}");
    assert!(matches!(&entries[0], Entry::User { text, .. } if text == "lose me"));
    assert!(matches!(&entries[1], Entry::End { outcome: TurnOutcome::Lost, .. }), "{:?}", entries[1]);
    assert_eq!(view.state.entry_count, 2);
}

#[tokio::test]
async fn shutdown_leaves_no_child_pid_alive_and_ends_the_turn_stopped() {
    let mut h = Harness::open().await;
    h.use_fake("slow");
    let chat = h.chat(Permission::Auto);
    h.send(chat, "go").await;
    h.wait_entry(chat, "streaming text", |s| matches!(s.entry, Entry::Text { .. })).await;
    let pid = h.turn_pids()[0];
    let started = Instant::now();
    h.engine.shutdown().await;
    assert!(started.elapsed() < Duration::from_secs(4), "shutdown is bounded");
    wait_dead(pid).await;
    let entries = h.entries(chat).await;
    assert!(matches!(entries.last(), Some(Entry::End { outcome: TurnOutcome::Stopped, .. })), "{:?}", entries.last());
}

#[tokio::test]
async fn approve_works_from_a_thread_without_a_runtime() {
    let mut h = Harness::open().await;
    h.use_fake("query");
    let chat = h.chat(Permission::AskFirst);
    h.send(chat, "How many orders?").await;
    let (approval, _) = h.wait_approval(chat).await;
    let caller = h.engine.clone();
    let other = ChatId(uuid::Uuid::new_v4());
    let answered = std::thread::spawn(move || {
        caller.assistant_stop(other);
        assert_eq!(caller.assistant_approve(other, approval, Decision::Run), Err(ApproveError::NotPending), "another chat's id");
        caller.assistant_approve(chat, approval, Decision::Run)
    })
    .join()
    .expect("panicked off the runtime");
    assert_eq!(answered, Ok(()));
    assert_eq!(h.wait_end(chat).await.0, TurnOutcome::Completed);
}

#[tokio::test]
async fn an_empty_message_a_disabled_provider_and_a_gone_attachment_are_refused() {
    let h = Harness::open().await;
    h.use_fake("card");
    let chat = h.chat(Permission::Auto);
    assert_eq!(h.engine.assistant_send(chat, SendRequest { text: "  \n".into(), tab: None }).await.unwrap_err(), SendError::EmptyMessage);
    let gone = TabContext {
        tab_id: TabId(uuid::Uuid::new_v4()),
        title: "t.sql".into(),
        db: None,
        text: "select 1".into(),
        target: RunTarget::All,
        attach: Some(ResultRef { tab_id: TabId(uuid::Uuid::new_v4()), run_id: RunId(1), index: 0 }),
    };
    assert_eq!(h.engine.assistant_send(chat, SendRequest { text: "x".into(), tab: Some(gone) }).await.unwrap_err(), SendError::AttachmentGone);
    h.configure_provider(|p| p.enabled = false);
    assert_eq!(h.engine.assistant_send(chat, SendRequest { text: "x".into(), tab: None }).await.unwrap_err(), SendError::ProviderOff { provider: ProviderKind::Claude });
    assert!(h.engine.boot().chats.is_empty(), "a refused send stores nothing");
}

#[tokio::test]
async fn a_draft_opens_with_default_options_and_configure_validates_against_the_probe() {
    let mut h = Harness::open().await;
    h.use_fake("none");
    h.wait_fake_outcome(lists_the_fake_model).await;
    let chat = ChatId(uuid::Uuid::new_v4());
    let view = h.engine.assistant_open(chat).await.unwrap();
    assert_eq!((view.state.status, view.state.title.as_str(), view.state.entry_count, view.entries.len()), (ChatStatus::Draft, "", 0, 0));
    assert_eq!(view.state.options, ChatOptions { provider: ProviderKind::Claude, model: ModelId("opus".into()), effort: Some(EffortId("high".into())), permission: Permission::AskFirst });
    let options = |model: &str, effort: Option<&str>| ChatOptions { provider: ProviderKind::Claude, model: ModelId(model.into()), effort: effort.map(|e| EffortId(e.into())), permission: Permission::Auto };
    assert_eq!(h.engine.assistant_configure(chat, options("nope", None)).unwrap_err(), ChatError::UnknownModel { model: ModelId("nope".into()) });
    assert_eq!(h.engine.assistant_configure(chat, options("opus", Some("turbo"))).unwrap_err(), ChatError::UnsupportedEffort { effort: EffortId("turbo".into()) });
    assert_eq!(h.engine.assistant_configure(chat, options("fake", Some("low"))).unwrap_err(), ChatError::UnsupportedEffort { effort: EffortId("low".into()) });
    let state = h.engine.assistant_configure(chat, options("haiku", Some("max"))).unwrap();
    assert_eq!((state.status, state.options), (ChatStatus::Draft, options("haiku", Some("max"))));
    assert!(h.engine.boot().chats.is_empty(), "a draft is not listed");
    assert_eq!(h.engine.assistant_open(chat).await.unwrap().state.options, options("haiku", Some("max")));
}

#[tokio::test]
async fn delete_stops_the_turn_and_publishes_a_tombstone() {
    let mut h = Harness::open().await;
    h.use_fake("slow");
    let chat = h.chat(Permission::Auto);
    h.send(chat, "go").await;
    h.wait_entry(chat, "streaming text", |s| matches!(s.entry, Entry::Text { .. })).await;
    let pid = h.turn_pids()[0];
    h.engine.assistant_delete(chat).await;
    h.wait_chat(chat, "the tombstone", |s| s.status == ChatStatus::Deleted).await;
    wait_dead(pid).await;
    assert!(h.engine.boot().chats.is_empty());
    assert_eq!(h.engine.assistant_open(chat).await.unwrap().state.status, ChatStatus::Draft, "the id opens a fresh draft");
    h.engine.assistant_delete(chat).await;
}

#[cfg(feature = "pg-tests")]
mod pg {
    use super::*;
    use engine::draft_from_url;

    const DEFAULT_URL: &str = "postgres://l1data:l1data@localhost:5433/shop";

    async fn connected(h: &Harness) -> ConnectionConfig {
        let url = std::env::var("L1_DATA_TEST_PG").unwrap_or_else(|_| DEFAULT_URL.into());
        let config = h.engine.save_connection(draft_from_url(&url, "dev").unwrap()).await.unwrap();
        h.engine.connect(config.id).await.unwrap();
        config
    }

    fn tab(config: &ConnectionConfig, text: &str) -> TabContext {
        TabContext { tab_id: TabId(uuid::Uuid::new_v4()), title: "orders.sql".into(), db: Some(DatabaseRef { connection_id: config.id, database: config.database.clone() }), text: text.into(), target: RunTarget::All, attach: None }
    }

    async fn send_on(h: &Harness, chat: ChatId, text: &str, tab: TabContext) {
        h.engine.assistant_send(chat, SendRequest { text: text.into(), tab: Some(tab) }).await.unwrap();
    }

    async fn scalar(h: &Harness, config: &ConnectionConfig, sql: &str) -> String {
        let tab_id = TabId(uuid::Uuid::new_v4());
        h.engine.console_configure(tab_id, ConsoleConfig { connection_id: config.id, database: config.database.clone(), schema: None, mode: TxnMode::AutoCommit }).await.unwrap();
        let accepted = h.engine.console_run(tab_id, RunRequest::Script { text: sql.into(), target: RunTarget::All }).await.unwrap();
        let started = Instant::now();
        loop {
            let state = h.engine.boot().consoles.into_iter().find(|c| c.tab_id == tab_id).unwrap();
            if let RunState::Finished { run_id, .. } = state.run
                && run_id == accepted.run_id
            {
                break;
            }
            assert!(started.elapsed() < Duration::from_secs(10));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let page = h.engine.result_page(ResultRef { tab_id, run_id: accepted.run_id, index: 0 }, 0, 1).unwrap();
        h.engine.console_close(tab_id, true).await.unwrap();
        page.rows[0][0].clone().unwrap()
    }

    #[tokio::test]
    async fn a_manual_tab_with_an_uncommitted_insert_is_untouched_and_the_approved_count_does_not_see_it() {
        let mut h = Harness::open().await;
        h.use_fake("query");
        let config = connected(&h).await;
        let before = scalar(&h, &config, "select count(*) from public.orders").await;
        let manual = TabId(uuid::Uuid::new_v4());
        h.engine.console_configure(manual, ConsoleConfig { connection_id: config.id, database: config.database.clone(), schema: None, mode: TxnMode::Manual }).await.unwrap();
        h.engine.console_run(manual, RunRequest::Script { text: "insert into public.orders (number, customer_id, total) values ('ASSIST-TXN', 1, 1)".into(), target: RunTarget::All }).await.unwrap();
        let started = Instant::now();
        loop {
            let state = h.engine.boot().consoles.into_iter().find(|c| c.tab_id == manual).unwrap();
            if matches!(state.run, RunState::Finished { .. }) {
                assert_eq!(state.txn, TxnState::Active, "{state:?}");
                break;
            }
            assert!(started.elapsed() < Duration::from_secs(10));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let chat = h.chat(Permission::AskFirst);
        send_on(&h, chat, "How many orders?", tab(&config, "select 1")).await;
        let (approval, _) = h.wait_approval(chat).await;
        h.engine.assistant_approve(chat, approval, Decision::Run).unwrap();
        assert_eq!(h.wait_end(chat).await.0, TurnOutcome::Completed);
        let entries = h.entries(chat).await;
        let Entry::Tool { status: ToolStatus::Done { result: ToolResult::Rows { columns, rows, more, .. } }, .. } = &entries[1] else { panic!("{:?}", entries[1]) };
        assert_eq!((columns.clone(), rows.clone(), *more), (vec!["count".to_owned()], vec![vec![Some(before.clone())]], false));
        assert!(text_of(&entries[2]).contains(&format!("count\n{before}\n1 rows")));
        let tab_state = h.engine.boot().consoles.into_iter().find(|c| c.tab_id == manual).unwrap();
        assert_eq!(tab_state.txn, TxnState::Active, "the tab's transaction is untouched");
        h.engine.console_rollback(manual).await.unwrap();
        assert_eq!(scalar(&h, &config, "select count(*) from public.orders").await, before);
    }

    #[tokio::test]
    async fn describe_tables_lists_the_foreign_key_and_an_index() {
        let mut h = Harness::open().await;
        h.use_fake("describe");
        let config = connected(&h).await;
        let chat = h.chat(Permission::AskFirst);
        send_on(&h, chat, "Describe orders", tab(&config, "")).await;
        assert_eq!(h.wait_end(chat).await.0, TurnOutcome::Completed);
        let entries = h.entries(chat).await;
        assert!(matches!(&entries[1], Entry::Tool { status: ToolStatus::Done { result: ToolResult::Described { found, missing } }, .. } if found == &["public.orders".to_owned()] && missing.is_empty()), "{:?}", entries[1]);
        let text = text_of(&entries[2]);
        assert!(text.contains("public.orders (table"), "{text}");
        assert!(text.contains("customer_id bigint NOT NULL FK → public.customers(id)"), "{text}");
        assert!(text.contains("orders_created_at_idx (created_at DESC)"), "{text}");
        assert!(text.contains("orders_open_idx (status) WHERE ") && text.contains("status <> 'paid'::text"), "{text}");
        assert!(!h.stdin_lines().iter().any(|l| l.contains("AwaitingApproval")) && !entries.iter().any(|e| matches!(e, Entry::Tool { status: ToolStatus::AwaitingApproval { .. }, .. })), "a catalog tool never asks");
    }

    #[tokio::test]
    async fn the_context_sends_the_outline_once_per_session_and_the_tab_sql_when_it_changes() {
        let mut h = Harness::open().await;
        h.use_fake("echo");
        let config = connected(&h).await;
        let chat = h.chat(Permission::Auto);
        send_on(&h, chat, "first", tab(&config, "select * from orders")).await;
        assert_eq!(h.wait_end(chat).await.0, TurnOutcome::Completed);
        let first = text_of(&h.entries(chat).await[1]);
        assert!(first.contains("Connection: dev (PostgreSQL ") && first.contains(", database shop, connected."), "{first}");
        assert!(first.contains("Default schema: public. Shown schemas: lab, public.") && first.contains("Schema outline:\nlab.type_zoo, ~") && first.contains("public.orders, ~"), "{first}");
        assert!(first.contains("Tab SQL:\nselect * from orders\nStatement at the cursor:\nselect * from orders\n"), "{first}");
        send_on(&h, chat, "second", tab(&config, "select * from orders")).await;
        assert_eq!(h.wait_end(chat).await.0, TurnOutcome::Completed);
        let second = text_of(&h.entries(chat).await[4]);
        assert!(second.contains("Tab SQL: unchanged since your last message.") && second.contains("Schema outline: unchanged since earlier in this chat."), "{second}");
        send_on(&h, chat, "third", tab(&config, "select * from customers")).await;
        assert_eq!(h.wait_end(chat).await.0, TurnOutcome::Completed);
        let third = text_of(&h.entries(chat).await[7]);
        assert!(third.contains("Tab SQL:\nselect * from customers\n") && third.contains("Schema outline: unchanged since earlier in this chat."), "{third}");
        let user = &h.entries(chat).await[0];
        assert!(matches!(user, Entry::User { context: Some(SentContext { connection_name: Some(name), tab_title, .. }), .. } if name == "dev" && tab_title == "orders.sql"), "{user:?}");
    }
}

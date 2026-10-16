//! The seam between the engine and a CLI agent. Everything a provider differs in sits behind
//! `Provider` and the sans-IO `Codec`; the registry, the probe scheduling, the health loop, and the
//! process driver in `agent.rs` are written once.

pub(crate) mod agent;
pub(crate) mod claude;

use std::collections::HashMap;
use std::ffi::OsString;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde_json::Value;

use crate::Shared;
use crate::console::now_ms;
use crate::model::{AgentError, AppEvent, Decision, EffortId, ModelId, ModelOption, ProbeOutcome, ProviderConfig, ProviderInfo, ProviderKind, ProviderState, ToolCallId, TurnOutcome};

pub(crate) type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

const HEALTH_TICK: Duration = Duration::from_secs(5);
const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(3);

pub(crate) trait Provider: Send + Sync {
    fn info(&self) -> ProviderInfo;
    /// What a chat starts on before any probe has answered.
    fn fallback_model(&self) -> (ModelId, Option<EffortId>);
    /// Version and sign-in without a model turn.
    fn quick_probe<'a>(&'a self, cfg: &'a ProviderConfig, host: &'a HostEnv) -> BoxFuture<'a, Result<Quick, ProbeOutcome>>;
    /// argv, env, and cwd for one process. Pure.
    fn launch(&self, cfg: &ProviderConfig, host: &HostEnv, start: &SessionStart) -> Result<LaunchSpec, AgentError>;
    /// A fresh protocol state machine for one process.
    fn codec(&self, cfg: &ProviderConfig, open: Open) -> Box<dyn Codec>;
}

/// Exhaustive, so adding a `ProviderKind` fails to compile until its module is named here.
pub(crate) fn provider(kind: ProviderKind) -> &'static dyn Provider {
    match kind {
        ProviderKind::Claude => &claude::Claude,
    }
}

/// Sans-IO: lines in, provider-neutral events and reply lines out. No clock, no tasks, no pipes.
pub(crate) trait Codec: Send {
    /// Lines to write right after spawn.
    fn open(&mut self) -> Vec<String>;
    fn user_turn(&mut self, text: &str) -> Vec<String>;
    fn interrupt(&mut self) -> Vec<String>;
    /// `input` is echoed back as the input to run on, so the tool runs on exactly what the gate saw.
    fn permission(&mut self, reply: &ReplyTo, decision: Decision, input: &Value, message: &str) -> Vec<String>;
    fn tool_result(&mut self, reply: &ReplyTo, result: &ModelResult) -> Vec<String>;
    /// One stdout line. Answers what the codec can answer itself in `replies`; hands the rest up as
    /// events. An unparseable or unknown line yields nothing.
    fn read(&mut self, line: &str) -> Step;
}

#[derive(Debug, Default, PartialEq)]
pub(crate) struct Step {
    pub replies: Vec<String>,
    pub events: Vec<AgentEvent>,
}

/// The codec's routing data for one answer. Opaque outside the codec that made it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ReplyTo(pub(crate) Value);

/// Text the model receives for one tool call; `is_error` marks a refusal or a failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ModelResult {
    pub text: String,
    pub is_error: bool,
}

/// What the codec reports. `name` is the engine's tool name; the codec strips its own prefix.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum AgentEvent {
    Ready(Handshake),
    TurnStarted { session_id: String },
    Text { block: BlockKey, delta: String },
    TextDone { block: BlockKey },
    ToolUse { call: ToolCallId, name: String, input: Value },
    Permission { reply: ReplyTo, call: ToolCallId, name: String, input: Value },
    ToolCall { reply: ReplyTo, call: ToolCallId, name: String, input: Value },
    ToolCancelled { call: ToolCallId },
    TurnEnded(TurnOutcome),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Handshake {
    pub version: Option<String>,
    pub plan: Option<String>,
    pub models: Vec<ModelOption>,
}

/// (message number within the process, content block index). The index restarts with every message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) struct BlockKey(pub u32, pub u32);

/// What `Codec::open` announces: the system prompt and the tools the process may call.
#[derive(Clone, Copy)]
pub(crate) struct Open {
    pub system_prompt: &'static str,
    pub tools: &'static [ToolSpec],
}

impl Open {
    /// The no-turn handshake: no prompt, no tools.
    pub(crate) const PROBE: Open = Open { system_prompt: "", tools: &[] };
}

pub(crate) struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: fn() -> Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum ProbeDepth {
    /// Version and sign-in. The health loop's default.
    Quick,
    /// Also the no-turn handshake for the plan and the models.
    Full,
}

/// A Quick probe that found a working binary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Quick {
    pub version: String,
    pub signed_in: bool,
    pub plan: Option<String>,
}

pub(crate) struct SessionStart {
    /// `None` runs the provider's default, as the no-turn handshake does.
    pub model: Option<ModelId>,
    pub effort: Option<EffortId>,
    pub resume: Option<String>,
}

pub(crate) struct LaunchSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env_set: Vec<(OsString, OsString)>,
    pub env_remove: Vec<OsString>,
    pub cwd: PathBuf,
}

/// The PATH an agent binary named without a directory is looked up on, and the PATH the agent
/// runs with. `LoginShell` is the app's: a Finder-launched app gets launchd's PATH, which misses
/// where `claude` and `node` live, so the login shell's PATH comes first, then the inherited one,
/// then the usual install directories. `Fixed` is exactly the given PATH, with no shell and nothing
/// added; tests pass an empty one, so a bare `claude` probes `NotFound` and nothing installed on
/// the machine runs.
#[derive(Debug, Clone)]
pub enum AgentPath {
    LoginShell,
    Fixed(OsString),
}

/// Captured once per engine, on first use.
pub(crate) struct HostEnv {
    pub path: OsString,
    pub home: PathBuf,
    /// `<data_dir>/assistant`. Fixed, so a resumed session finds the CLI's transcript.
    pub cwd: PathBuf,
}

impl HostEnv {
    pub(crate) async fn capture(agent_path: &AgentPath, cwd: PathBuf) -> Self {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        let path = match agent_path {
            AgentPath::Fixed(path) => path.clone(),
            AgentPath::LoginShell => {
                let inherited = std::env::var_os("PATH").unwrap_or_default();
                let shell_path = login_shell_path().await.unwrap_or_default();
                let mut dirs: Vec<PathBuf> = std::env::split_paths(&shell_path).chain(std::env::split_paths(&inherited)).filter(|p| !p.as_os_str().is_empty()).collect();
                for extra in [home.join(".local/bin"), home.join(".claude/local"), PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")] {
                    if !dirs.contains(&extra) {
                        dirs.push(extra);
                    }
                }
                std::env::join_paths(&dirs).unwrap_or(inherited)
            }
        };
        Self { path, home, cwd }
    }

    /// An empty entry would mean the current directory to a shell; here it means nothing.
    pub(crate) fn dirs(&self) -> Vec<PathBuf> {
        std::env::split_paths(&self.path).filter(|p| !p.as_os_str().is_empty()).collect()
    }

    pub(crate) fn expand_home(&self, path: &str) -> PathBuf {
        match path.strip_prefix("~/") {
            Some(rest) => self.home.join(rest),
            None if path == "~" => self.home.clone(),
            None => PathBuf::from(path),
        }
    }
}

async fn login_shell_path() -> Option<OsString> {
    let shell = std::env::var_os("SHELL")?;
    let output = tokio::time::timeout(LOGIN_SHELL_TIMEOUT, tokio::process::Command::new(shell).args(["-lc", "printf %s \"$PATH\""]).kill_on_drop(true).output()).await.ok()?.ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let path = text.lines().last()?.trim();
    (!path.is_empty()).then(|| OsString::from(path))
}

pub(crate) struct Providers {
    entries: Mutex<HashMap<ProviderKind, ProviderEntry>>,
    agent_path: AgentPath,
    host: tokio::sync::OnceCell<HostEnv>,
}

#[derive(Default)]
struct ProviderEntry {
    rev: u64,
    checking: bool,
    checked_at_ms: Option<i64>,
    outcome: Option<ProbeOutcome>,
    /// A probe runs; the deepest request that arrived meanwhile runs once it finishes.
    running: bool,
    owed: Option<ProbeDepth>,
}

impl ProviderEntry {
    fn state(&self, kind: ProviderKind) -> ProviderState {
        ProviderState { provider: kind, rev: self.rev, info: provider(kind).info(), checking: self.checking, checked_at_ms: self.checked_at_ms, outcome: self.outcome.clone() }
    }

    fn version(&self) -> Option<&str> {
        match self.outcome.as_ref()? {
            ProbeOutcome::Ready { version, .. } | ProbeOutcome::SignedOut { version } => Some(version),
            ProbeOutcome::Broken { version, .. } => version.as_deref(),
            ProbeOutcome::NotFound { .. } => None,
        }
    }

    fn models(&self) -> Option<&[ModelOption]> {
        match self.outcome.as_ref()? {
            ProbeOutcome::Ready { models, .. } => Some(models),
            _ => None,
        }
    }
}

impl Providers {
    pub(crate) fn new(agent_path: AgentPath) -> Self {
        Self { entries: Mutex::new(HashMap::new()), agent_path, host: tokio::sync::OnceCell::new() }
    }

    pub(crate) fn states(&self) -> Vec<ProviderState> {
        let entries = self.entries.lock().unwrap();
        ProviderKind::ALL.iter().map(|&kind| entries.get(&kind).map_or_else(|| ProviderEntry::default().state(kind), |e| e.state(kind))).collect()
    }

    /// The last Ready probe's models, which `assistant_configure` and `assistant_send` validate against.
    pub(crate) fn models(&self, kind: ProviderKind) -> Option<Vec<ModelOption>> {
        self.entries.lock().unwrap().get(&kind)?.models().map(<[ModelOption]>::to_vec)
    }

    fn due(&self, kind: ProviderKind, every_secs: u32) -> bool {
        let entries = self.entries.lock().unwrap();
        let Some(entry) = entries.get(&kind) else { return false };
        !entry.checking && entry.checked_at_ms.is_some_and(|at| now_ms() - at >= i64::from(every_secs) * 1000)
    }
}

impl Shared {
    pub(crate) async fn host_env(&self) -> &HostEnv {
        self.providers.host.get_or_init(|| HostEnv::capture(&self.providers.agent_path, self.assistant_dir())).await
    }

    pub(crate) fn assistant_dir(&self) -> PathBuf {
        self.data_dir.join("assistant")
    }

    fn provider_config(&self, kind: ProviderKind) -> Option<ProviderConfig> {
        self.settings().providers.into_iter().find(|c| c.provider == kind)
    }

    /// Probes every enabled provider.
    pub(crate) fn probe_all(self: &Arc<Self>, depth: ProbeDepth) {
        for cfg in self.settings().providers {
            if cfg.enabled {
                self.probe(cfg.provider, depth);
            }
        }
    }

    /// Single-flight per provider: a burst of requests costs at most two probes, the second at the
    /// deepest depth asked for meanwhile. Publishes `checking`, then the outcome.
    pub(crate) fn probe(self: &Arc<Self>, kind: ProviderKind, depth: ProbeDepth) {
        {
            let mut entries = self.providers.entries.lock().unwrap();
            let entry = entries.entry(kind).or_default();
            if entry.running {
                entry.owed = Some(entry.owed.map_or(depth, |owed| owed.max(depth)));
                return;
            }
            entry.running = true;
        }
        let shared = self.clone();
        self.spawn(async move {
            let mut depth = depth;
            loop {
                shared.publish_provider(kind, |e| e.checking = true);
                let outcome = shared.run_probe(kind, depth).await;
                shared.publish_provider(kind, |e| {
                    e.checking = false;
                    e.checked_at_ms = Some(now_ms());
                    e.outcome = Some(outcome);
                });
                let again = {
                    let mut entries = shared.providers.entries.lock().unwrap();
                    let entry = entries.entry(kind).or_default();
                    match entry.owed.take() {
                        Some(next) => Some(next),
                        None => {
                            entry.running = false;
                            None
                        }
                    }
                };
                match again {
                    Some(next) => depth = next,
                    None => return,
                }
            }
        });
    }

    fn publish_provider(&self, kind: ProviderKind, edit: impl FnOnce(&mut ProviderEntry)) {
        let state = {
            let mut entries = self.providers.entries.lock().unwrap();
            let entry = entries.entry(kind).or_default();
            edit(entry);
            entry.rev += 1;
            entry.state(kind)
        };
        self.emit(AppEvent::ProviderChanged(state));
    }

    async fn run_probe(self: &Arc<Self>, kind: ProviderKind, depth: ProbeDepth) -> ProbeOutcome {
        let Some(cfg) = self.provider_config(kind) else { return ProbeOutcome::NotFound { binary: String::new() } };
        let host = self.host_env().await;
        let p = provider(kind);
        let quick = match p.quick_probe(&cfg, host).await {
            Ok(quick) => quick,
            Err(outcome) => return outcome,
        };
        if !quick.signed_in {
            return ProbeOutcome::SignedOut { version: quick.version };
        }
        let kept = {
            let entries = self.providers.entries.lock().unwrap();
            let entry = entries.get(&kind);
            let same_version = entry.and_then(ProviderEntry::version) == Some(quick.version.as_str());
            if depth == ProbeDepth::Quick && same_version { entry.and_then(ProviderEntry::models).map(<[ModelOption]>::to_vec) } else { None }
        };
        if let Some(models) = kept {
            return ProbeOutcome::Ready { version: quick.version, plan: quick.plan, models };
        }
        let start = SessionStart { model: None, effort: None, resume: None };
        let handshake = async {
            let spec = p.launch(&cfg, host, &start).map_err(|e| match e {
                AgentError::NotFound { binary } => format!("{binary} is not an executable file"),
                AgentError::SignedOut => "signed out".to_owned(),
                AgentError::Exited { detail, .. } | AgentError::Provider { message: detail } => detail,
            })?;
            let (agent, handshake) = agent::Agent::start(self, spec, p.codec(&cfg, Open::PROBE)).await.map_err(|e| e.to_string())?;
            agent.close().await;
            Ok::<_, String>(handshake)
        };
        match handshake.await {
            Ok(h) => ProbeOutcome::Ready { version: h.version.unwrap_or(quick.version), plan: h.plan.or(quick.plan), models: h.models },
            Err(message) => ProbeOutcome::Broken { version: Some(quick.version), message },
        }
    }

    /// Re-probes each provider whose `enabled` or runtime fields changed.
    pub(crate) fn reprobe_changed(self: &Arc<Self>, before: &[ProviderConfig], after: &[ProviderConfig]) {
        for cfg in after {
            let was = before.iter().find(|c| c.provider == cfg.provider);
            let changed = was.is_none_or(|w| w.enabled != cfg.enabled || w.binary_path != cfg.binary_path || w.config_dir != cfg.config_dir || w.launch_args != cfg.launch_args);
            if changed && cfg.enabled {
                self.probe(cfg.provider, ProbeDepth::Full);
            }
        }
    }
}

/// Every 5 s: when `provider_health_check_secs > 0`, a Quick probe of each enabled provider whose
/// last probe is older than that. `run_probe` escalates to Full on its own when the version changed.
pub(crate) async fn health_loop(shared: Weak<Shared>) {
    let mut tick = tokio::time::interval(HEALTH_TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let Some(shared) = shared.upgrade() else { return };
        let settings = shared.settings();
        if settings.provider_health_check_secs == 0 {
            continue;
        }
        for cfg in &settings.providers {
            if cfg.enabled && shared.providers.due(cfg.provider, settings.provider_health_check_secs) {
                shared.probe(cfg.provider, ProbeDepth::Quick);
            }
        }
    }
}

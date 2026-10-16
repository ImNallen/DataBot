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

    async fn wait_provider(&mut self, what: &str, done: impl Fn(&ProviderState) -> bool) -> ProviderState {
        let started = Instant::now();
        loop {
            let remaining = WAIT.checked_sub(started.elapsed()).unwrap_or_else(|| panic!("timed out waiting for {what}"));
            match tokio::time::timeout(remaining, self.events.recv()).await {
                Ok(Ok(AppEvent::ProviderChanged(state))) if done(&state) => return state,
                Ok(Ok(_)) => {}
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => {}
                Ok(Err(e)) => panic!("{e}"),
                Err(_) => panic!("timed out waiting for {what}"),
            }
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

    fn handshakes(&self) -> usize {
        std::fs::read_to_string(self.log_path()).unwrap_or_default().lines().filter(|l| l.starts_with("argv\t")).count()
    }
}

fn lists_the_fake_model(outcome: &ProbeOutcome) -> bool {
    matches!(outcome, ProbeOutcome::Ready { models, .. } if models.iter().any(|m| m.id.0 == "fake"))
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
    let log = std::fs::read_to_string(h.log_path()).unwrap();
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

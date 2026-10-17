use std::time::Duration;

use futures_util::future::join_all;

use super::agent::StartError;
use super::{HostEnv, claude, codex, provider};
use crate::Shared;
use crate::console::now_ms;
use crate::model::{LimitLevel, LimitSource, LimitsOutcome, LimitsReport, ProbeOutcome, ProviderKind, SourceLimits, default_config};

const LIMITS_TIMEOUT: Duration = Duration::from_secs(8);
const LOW_AT_LEFT: u8 = 20;

impl Shared {
    pub(crate) async fn read_limits(&self) -> LimitsReport {
        let host = self.host_env().await;
        let sources = join_all(LimitSource::ALL.map(|source| self.read_source(source, host))).await;
        LimitsReport { checked_at_ms: now_ms(), sources }
    }

    async fn read_source(&self, source: LimitSource, host: &HostEnv) -> SourceLimits {
        let cfg = self.provider_config(ProviderKind::Claude).unwrap_or_else(|| default_config(ProviderKind::Claude));
        let name = match source {
            LimitSource::Claude => cfg.display_name.clone(),
            LimitSource::Codex => "Codex".to_owned(),
        };
        let read = async {
            match source {
                LimitSource::Claude => match claude::read_limits(self, &cfg, host).await {
                    Ok(usage) => {
                        let probe = self.providers.entries.lock().unwrap().get(&ProviderKind::Claude).and_then(|e| e.outcome.clone());
                        claude_outcome(usage, probe.as_ref(), &provider(ProviderKind::Claude).info().sign_in_command)
                    }
                    Err(outcome) => outcome,
                },
                LimitSource::Codex => codex::read_limits(self, host).await,
            }
        };
        let outcome = tokio::time::timeout(LIMITS_TIMEOUT, read).await.unwrap_or_else(|_| LimitsOutcome::Failed { message: format!("no answer within {} s", LIMITS_TIMEOUT.as_secs()) });
        SourceLimits { source, name, outcome }
    }
}

fn claude_outcome(usage: claude::ClaudeUsage, probe: Option<&ProbeOutcome>, sign_in_command: &str) -> LimitsOutcome {
    match usage {
        claude::ClaudeUsage::Limited { plan, windows } => LimitsOutcome::Ready { plan, windows },
        claude::ClaudeUsage::NoRateLimits { .. } if matches!(probe, Some(ProbeOutcome::SignedOut { .. })) => LimitsOutcome::SignedOut { sign_in_command: sign_in_command.to_owned() },
        claude::ClaudeUsage::NoRateLimits { plan } => LimitsOutcome::NoLimits { plan },
    }
}

pub(crate) fn start_failed(e: StartError) -> LimitsOutcome {
    match e {
        StartError::NotFound { binary } => LimitsOutcome::NotFound { binary },
        other => LimitsOutcome::Failed { message: other.to_string() },
    }
}

pub(crate) fn level(left_percent: u8, severity: Option<&str>) -> LimitLevel {
    match (left_percent, severity) {
        (0, _) => LimitLevel::Exhausted,
        (left, _) if left <= LOW_AT_LEFT => LimitLevel::Low,
        (_, Some(severity)) if severity != "normal" => LimitLevel::Low,
        _ => LimitLevel::Normal,
    }
}

pub(crate) fn window_label_for_minutes(minutes: i64) -> String {
    match minutes {
        300 => "Session".into(),
        1440 => "Daily".into(),
        10080 => "Weekly".into(),
        m if m > 0 && m % 1440 == 0 => format!("{}-day", m / 1440),
        m if m > 0 && m % 60 == 0 => format!("{}-hour", m / 60),
        m => format!("{m}-minute"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn low_is_twenty_left_or_any_severity_but_normal_and_zero_is_exhausted() {
        assert_eq!(level(21, Some("normal")), LimitLevel::Normal);
        assert_eq!(level(20, None), LimitLevel::Low);
        assert_eq!(level(50, Some("warning")), LimitLevel::Low);
        assert_eq!(level(0, Some("normal")), LimitLevel::Exhausted);
        assert_eq!(level(100, None), LimitLevel::Normal);
    }

    #[test]
    fn windows_are_named_by_their_length() {
        let labels: Vec<String> = [300, 10080, 1440, 120, 4320, 90].into_iter().map(window_label_for_minutes).collect();
        assert_eq!(labels, ["Session", "Weekly", "Daily", "2-hour", "3-day", "90-minute"]);
    }

    #[test]
    fn no_windows_read_as_signed_out_only_when_the_probe_says_so() {
        let usage = || claude::ClaudeUsage::NoRateLimits { plan: None };
        let signed_out = ProbeOutcome::SignedOut { version: "2.1.301".into() };
        assert_eq!(claude_outcome(usage(), Some(&signed_out), "claude auth login"), LimitsOutcome::SignedOut { sign_in_command: "claude auth login".into() });
        assert_eq!(claude_outcome(usage(), None, "claude auth login"), LimitsOutcome::NoLimits { plan: None });
        let ready = ProbeOutcome::Ready { version: "2.1.301".into(), plan: Some("API key".into()), models: Vec::new() };
        assert_eq!(claude_outcome(usage(), Some(&ready), "claude auth login"), LimitsOutcome::NoLimits { plan: None });
        let windows = claude::ClaudeUsage::Limited { plan: Some("Max".into()), windows: Vec::new() };
        assert_eq!(claude_outcome(windows, Some(&signed_out), ""), LimitsOutcome::Ready { plan: Some("Max".into()), windows: Vec::new() }, "windows win over a stale probe");
    }
}

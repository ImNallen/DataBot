use serde_json::{Value, json};

use super::agent::{self, Exchange, Exchanged};
use super::{HostEnv, LaunchSpec, capitalize, limits};
use crate::Shared;
use crate::model::{LimitWindow, LimitsOutcome};

const BINARY: &str = "codex";
const SIGN_IN_COMMAND: &str = "codex login";
const INITIALIZE: u64 = 0;
const ACCOUNT: u64 = 1;
const RATE_LIMITS: u64 = 2;

/// `codex app-server` speaks JSON-RPC over JSONL with no `jsonrpc` field. After `initialize`
/// answers, both reads go out at once, and their replies arrive in either order: signed out, the
/// rate-limit error came before the account. Notifications interleave and are skipped.
#[derive(Default)]
pub(crate) struct CodexLimitsExchange {
    account: Option<CodexAccount>,
    rate_limits: Option<Result<Value, String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum CodexAccount {
    ChatGpt { plan: Option<String> },
    ApiKey,
    SignedOut,
}

impl CodexLimitsExchange {
    /// The account alone decides every case but a ChatGPT sign-in, which needs the rate limits.
    fn decide(&self) -> Option<LimitsOutcome> {
        Some(match (self.account.as_ref()?, &self.rate_limits) {
            (CodexAccount::SignedOut, _) => LimitsOutcome::SignedOut { sign_in_command: SIGN_IN_COMMAND.into() },
            (CodexAccount::ApiKey, _) => LimitsOutcome::NoLimits { plan: Some("API key".into()) },
            (CodexAccount::ChatGpt { plan }, Some(Ok(result))) => LimitsOutcome::Ready { plan: plan.clone(), windows: parse_rate_limits(result) },
            (CodexAccount::ChatGpt { .. }, Some(Err(message))) => LimitsOutcome::Failed { message: message.clone() },
            (CodexAccount::ChatGpt { .. }, None) => return None,
        })
    }
}

impl Exchange for CodexLimitsExchange {
    type Output = LimitsOutcome;

    fn open(&mut self) -> Vec<String> {
        vec![json!({ "method": "initialize", "id": INITIALIZE, "params": { "clientInfo": { "name": "l1data", "title": "L1 Data", "version": env!("CARGO_PKG_VERSION") } } }).to_string()]
    }

    fn read(&mut self, line: &str) -> Exchanged<LimitsOutcome> {
        let Ok(v) = serde_json::from_str::<Value>(line) else { return Exchanged::Skip };
        if v.get("method").is_some() {
            return Exchanged::Skip;
        }
        let reply = match v["error"]["message"].as_str() {
            Some(message) => Err(message.to_owned()),
            None => Ok(v["result"].clone()),
        };
        match (v["id"].as_u64(), reply) {
            (Some(INITIALIZE), Ok(_)) => {
                return Exchanged::Send(vec![
                    json!({ "method": "initialized" }).to_string(),
                    json!({ "method": "account/read", "id": ACCOUNT, "params": {} }).to_string(),
                    json!({ "method": "account/rateLimits/read", "id": RATE_LIMITS }).to_string(),
                ]);
            }
            (Some(INITIALIZE | ACCOUNT), Err(message)) => return Exchanged::Done(LimitsOutcome::Failed { message }),
            (Some(ACCOUNT), Ok(result)) => self.account = Some(parse_account(&result)),
            (Some(RATE_LIMITS), reply) => self.rate_limits = Some(reply),
            _ => return Exchanged::Skip,
        }
        self.decide().map_or(Exchanged::Skip, Exchanged::Done)
    }
}

pub(crate) fn parse_account(result: &Value) -> CodexAccount {
    let account = &result["account"];
    match account["type"].as_str() {
        _ if account.is_null() => CodexAccount::SignedOut,
        Some("chatgpt") => CodexAccount::ChatGpt { plan: account["planType"].as_str().map(|plan| format!("ChatGPT {}", capitalize(plan))) },
        _ => CodexAccount::ApiKey,
    }
}

/// A window is named by its length: the primary one is not always the five-hour session.
/// Shortest first, so a session sits above the week whichever slot it came in.
pub(crate) fn parse_rate_limits(result: &Value) -> Vec<LimitWindow> {
    let limits = &result["rateLimits"];
    let mut windows: Vec<(Option<i64>, LimitWindow)> = ["primary", "secondary"]
        .into_iter()
        .filter_map(|slot| {
            let window = &limits[slot];
            let left_percent = 100 - window["usedPercent"].as_f64()?.clamp(0.0, 100.0).round() as u8;
            let minutes = window["windowDurationMins"].as_i64();
            let label = minutes.map_or_else(|| "Limit".to_owned(), limits::window_label_for_minutes);
            let resets_at_ms = window["resetsAt"].as_i64().map(|secs| secs * 1000);
            Some((minutes, LimitWindow { id: slot.to_owned(), label, left_percent, resets_at_ms, level: limits::level(left_percent, None) }))
        })
        .collect();
    windows.sort_by_key(|(minutes, _)| minutes.unwrap_or(i64::MAX));
    windows.into_iter().map(|(_, window)| window).collect()
}

/// `codex` on the host PATH. Codex has no provider settings yet, so there is no binary path to honor.
pub(crate) async fn read_limits(shared: &Shared, host: &HostEnv) -> LimitsOutcome {
    let program = match host.resolve("", BINARY) {
        Ok(program) => program,
        Err(binary) => return LimitsOutcome::NotFound { binary },
    };
    let spec = LaunchSpec { program, args: vec!["app-server".into()], env_set: vec![("PATH".into(), host.path.clone())], env_remove: Vec::new(), cwd: host.cwd.clone() };
    agent::exchange(shared, &spec, CodexLimitsExchange::default()).await.unwrap_or_else(limits::start_failed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LimitLevel;

    const SIGNED_IN: &str = include_str!("../../tests/fixtures/codex/limits.jsonl");
    const SIGNED_OUT: &str = include_str!("../../tests/fixtures/codex/limits-signed-out.jsonl");

    fn json(line: &str) -> Value {
        serde_json::from_str(line).unwrap()
    }

    /// Feeds every captured line in order and returns what each one yielded.
    fn replay(fixture: &str) -> Vec<Exchanged<LimitsOutcome>> {
        let mut exchange = CodexLimitsExchange::default();
        exchange.open();
        fixture.lines().filter(|l| !l.trim().is_empty()).map(|l| exchange.read(l)).collect()
    }

    #[test]
    fn open_sends_initialize_and_its_answer_sends_initialized_and_both_reads() {
        let mut exchange = CodexLimitsExchange::default();
        let open = exchange.open();
        assert_eq!(json(&open[0]), json!({ "method": "initialize", "id": 0, "params": { "clientInfo": { "name": "l1data", "title": "L1 Data", "version": env!("CARGO_PKG_VERSION") } } }));
        let Exchanged::Send(lines) = exchange.read(SIGNED_IN.lines().next().unwrap()) else { panic!("the initialize answer sends the reads") };
        assert_eq!(
            lines.iter().map(|l| json(l)).collect::<Vec<_>>(),
            [json!({ "method": "initialized" }), json!({ "method": "account/read", "id": 1, "params": {} }), json!({ "method": "account/rateLimits/read", "id": 2 })]
        );
    }

    #[test]
    fn the_captured_signed_in_transcript_skips_notifications_and_ends_ready() {
        let steps = replay(SIGNED_IN);
        let window = LimitWindow { id: "primary".into(), label: "Weekly".into(), left_percent: 94, resets_at_ms: Some(1_792_655_854_000), level: LimitLevel::Normal };
        assert_eq!(steps[1..], [Exchanged::Skip, Exchanged::Skip, Exchanged::Skip, Exchanged::Done(LimitsOutcome::Ready { plan: Some("ChatGPT Pro".into()), windows: vec![window] })]);
    }

    #[test]
    fn signed_out_the_rate_limit_error_comes_first_and_the_null_account_decides() {
        let steps = replay(SIGNED_OUT);
        assert_eq!(steps[1..], [Exchanged::Skip, Exchanged::Skip, Exchanged::Done(LimitsOutcome::SignedOut { sign_in_command: "codex login".into() })]);
    }

    #[test]
    fn an_account_that_is_not_chatgpt_decides_without_the_rate_limits() {
        let mut exchange = CodexLimitsExchange::default();
        assert_eq!(exchange.read(r#"{"id":1,"result":{"account":{"type":"apiKey"},"requiresOpenaiAuth":true}}"#), Exchanged::Done(LimitsOutcome::NoLimits { plan: Some("API key".into()) }));
        let mut exchange = CodexLimitsExchange::default();
        assert_eq!(exchange.read(r#"{"id":1,"result":{"account":null}}"#), Exchanged::Done(LimitsOutcome::SignedOut { sign_in_command: "codex login".into() }));
    }

    #[test]
    fn errors_fail_the_read_and_unknown_ids_and_garbage_are_skipped() {
        let mut exchange = CodexLimitsExchange::default();
        assert_eq!(exchange.read(r#"{"id":1,"result":{"account":{"type":"chatgpt","planType":"plus"}}}"#), Exchanged::Skip, "a ChatGPT account waits for the rate limits");
        assert_eq!(exchange.read(r#"{"id":2,"error":{"code":-32603,"message":"backend unavailable"}}"#), Exchanged::Done(LimitsOutcome::Failed { message: "backend unavailable".into() }));
        let mut exchange = CodexLimitsExchange::default();
        assert_eq!(exchange.read(r#"{"id":0,"error":{"code":-32600,"message":"bad client"}}"#), Exchanged::Done(LimitsOutcome::Failed { message: "bad client".into() }));
        assert_eq!(exchange.read(r#"{"id":7,"result":{}}"#), Exchanged::Skip);
        assert_eq!(exchange.read("not json"), Exchanged::Skip);
        assert_eq!(exchange.read(r#"{"id":5,"method":"item/tool/requestUserInput","params":{}}"#), Exchanged::Skip, "a server request is not a reply");
    }

    #[test]
    fn windows_are_labelled_by_length_shortest_first_and_a_null_slot_is_dropped() {
        let result = json!({ "rateLimits": {
            "primary": { "usedPercent": 30, "windowDurationMins": 10080, "resetsAt": 1_792_655_854 },
            "secondary": { "usedPercent": 100, "windowDurationMins": 300, "resetsAt": null },
        } });
        let windows = parse_rate_limits(&result);
        assert_eq!(
            windows,
            [
                LimitWindow { id: "secondary".into(), label: "Session".into(), left_percent: 0, resets_at_ms: None, level: LimitLevel::Exhausted },
                LimitWindow { id: "primary".into(), label: "Weekly".into(), left_percent: 70, resets_at_ms: Some(1_792_655_854_000), level: LimitLevel::Normal },
            ]
        );
        assert_eq!(parse_rate_limits(&json!({ "rateLimits": { "primary": null, "secondary": null } })), []);
    }

    #[test]
    fn plan_types_read_as_chatgpt_tiers() {
        let plan = |t: &str| parse_account(&json!({ "account": { "type": "chatgpt", "planType": t } }));
        assert_eq!(plan("pro"), CodexAccount::ChatGpt { plan: Some("ChatGPT Pro".into()) });
        assert_eq!(plan("plus"), CodexAccount::ChatGpt { plan: Some("ChatGPT Plus".into()) });
        assert_eq!(parse_account(&json!({ "account": { "type": "chatgpt" } })), CodexAccount::ChatGpt { plan: None });
    }
}

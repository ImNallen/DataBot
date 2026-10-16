//! A stand-in for the `claude` CLI that speaks the frames captured from 2.1.301. The engine tests
//! point `binaryPath` at it and pick a scenario with `launchArgs = --fake-scenario <name>`. Every
//! stdin line and the argv go to `--fake-log <path>` or `$L1_FAKE_CLAUDE_LOG`. Not shipped.
//!
//! Scenarios, each one turn per user message:
//! - `card`: streams prose, a `sql` fence, inline code, and a trailing `followups` fence in small
//!   deltas 30 ms apart.
//! - `query`: asks `can_use_tool` for `run_query`, calls it when allowed, and answers with the
//!   tool's result. `query-tampered` calls with different arguments than it asked for.
//! - `describe`: the same for `describe_tables(["orders"])`.
//! - `slow`: a delta every 100 ms for 60 s; an `interrupt` gets the captured aborted sequence.
//! - `crash`: two deltas, then stderr text and exit 1.
//! - `resume-lost`: exits with an error before the handshake when argv has `--resume`.
//! - `echo`: answers with the whole prompt it received.
//! - anything else: answers "ok".

use std::collections::VecDeque;
use std::io::{BufRead, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const VERSION: &str = "2.1.301 (Claude Code)";
const CARD_REPLY: &str = "This compares paid revenue by region over the last 90 days:\n\n```sql\nselect c.region, count(*) as orders, sum(o.total) as revenue\nfrom orders o join customers c on c.id = o.customer_id\nwhere o.status = 'paid' and o.created_at > now() - interval '90 days'\ngroup by c.region order by revenue desc\n```\n\n`revenue` sums `o.total` for paid orders only.\n\n```followups\nShow growth as a percentage\nOnly EU regions\n```\n";
const DELTA_CHARS: usize = 12;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut log = Log::open(&args);
    log.write("argv", &json!(args).to_string());
    log.write("pid", &std::process::id().to_string());
    if args == ["--version"] {
        println!("{VERSION}");
        return;
    }
    if args == ["auth", "status"] {
        let signed_out = std::env::var("CLAUDE_CONFIG_DIR").is_ok_and(|d| d.trim_end_matches('/').ends_with("signed-out"));
        let status = if signed_out {
            json!({ "loggedIn": false, "authMethod": "none", "apiProvider": "firstParty" })
        } else {
            json!({ "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "email": "user@example.com", "subscriptionType": "max" })
        };
        println!("{status}");
        std::process::exit(if signed_out { 1 } else { 0 });
    }
    let value_of = |flag: &str| args.windows(2).find(|w| w[0] == flag).map(|w| w[1].clone());
    let scenario = value_of("--fake-scenario").unwrap_or_default();
    let resume = value_of("--resume");
    if scenario == "resume-lost"
        && let Some(id) = resume
    {
        println!("{}", json!({ "type": "result", "subtype": "error_during_execution", "is_error": true, "num_turns": 0, "session_id": id, "errors": [format!("No conversation found with session ID: {id}")], "result_index": 0 }));
        eprintln!("No conversation found with session ID: {id}");
        std::process::exit(1);
    }
    let session_id = resume.unwrap_or_else(|| format!("fake-session-{}", std::process::id()));
    let model = value_of("--model").unwrap_or_else(|| "claude-opus-5-5".into());
    let mut cli = Cli { stdin: stdin_lines(), backlog: VecDeque::new(), log, session_id, model, next_id: 0 };
    cli.handshake();
    cli.run(&scenario);
}

struct Log(Option<std::fs::File>);

impl Log {
    fn open(args: &[String]) -> Self {
        let path = args.windows(2).find(|w| w[0] == "--fake-log").map(|w| w[1].clone()).or_else(|| std::env::var("L1_FAKE_CLAUDE_LOG").ok());
        Self(path.and_then(|p| std::fs::OpenOptions::new().create(true).append(true).open(p).ok()))
    }

    /// One write call per line, so lines from the probe's process and a turn's never interleave.
    fn write(&mut self, kind: &str, text: &str) {
        if let Some(file) = self.0.as_mut() {
            let _ = file.write_all(format!("{kind}\t{text}\n").as_bytes());
        }
    }
}

enum Stdin {
    Line(String),
    Eof,
}

fn stdin_lines() -> mpsc::Receiver<Stdin> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(line) => {
                    if tx.send(Stdin::Line(line)).is_err() {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = tx.send(Stdin::Eof);
    });
    rx
}

struct Cli {
    stdin: mpsc::Receiver<Stdin>,
    /// Lines that arrived while `expect` waited for something else, handed out first, in order:
    /// the host sends its user message while the MCP handshake is still in flight.
    backlog: VecDeque<Value>,
    log: Log,
    session_id: String,
    model: String,
    next_id: u64,
}

impl Cli {
    fn send(&mut self, frame: Value) {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{frame}");
        let _ = out.flush();
    }

    fn parse(&mut self, line: String) -> Value {
        self.log.write("stdin", &line);
        serde_json::from_str(&line).unwrap_or(Value::Null)
    }

    /// The next stdin line within `wait`, or `None` when the host stays silent.
    fn poll_line(&mut self, wait: Duration) -> Option<Value> {
        if let Some(v) = self.backlog.pop_front() {
            return Some(v);
        }
        match self.stdin.recv_timeout(wait) {
            Ok(Stdin::Line(line)) => Some(self.parse(line)),
            Ok(Stdin::Eof) | Err(mpsc::RecvTimeoutError::Disconnected) => std::process::exit(0),
            Err(mpsc::RecvTimeoutError::Timeout) => None,
        }
    }

    fn expect(&mut self, what: &str, pick: impl Fn(&Value) -> bool) -> Value {
        if let Some(at) = self.backlog.iter().position(&pick) {
            return self.backlog.remove(at).expect("found above");
        }
        loop {
            let v = self.read_line();
            if pick(&v) {
                return v;
            }
            self.log.write("queued", &format!("while waiting for {what}: {v}"));
            self.backlog.push_back(v);
        }
    }

    /// The next stdin line as JSON. EOF ends the process like the real CLI does.
    fn read_line(&mut self) -> Value {
        match self.stdin.recv() {
            Ok(Stdin::Line(line)) => self.parse(line),
            Ok(Stdin::Eof) | Err(_) => std::process::exit(0),
        }
    }

    fn next_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    fn mcp(&mut self, message: Value) -> Value {
        let id = format!("fake-req-{}", self.next_id());
        self.send(json!({ "type": "control_request", "request_id": id, "request": { "subtype": "mcp_message", "server_name": "l1", "message": message } }));
        self.expect("an MCP answer", |v| v["response"]["request_id"] == id)
    }

    /// `initialize` from the host, then the SDK MCP server's own handshake, as the real CLI does.
    fn handshake(&mut self) {
        let init = self.expect("initialize", |v| v["request"]["subtype"] == "initialize");
        let models = ["opus", "fable", "sonnet", "haiku"].map(|value| {
            json!({ "value": value, "resolvedModel": format!("claude-{value}-5-5"), "displayName": format!("{} 5.5", capitalize(value)), "description": "Fake", "supportsEffort": true, "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"] })
        });
        let mut list = vec![json!({ "value": "default", "resolvedModel": "claude-opus-5-5", "displayName": "Default (recommended)", "description": "Opus 5.5", "supportsEffort": true, "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"] })];
        list.extend(models);
        list.push(json!({ "value": "fake", "resolvedModel": "fake-1-0", "displayName": "Fake 1.0", "description": "Only the stand-in lists this model", "supportsThinkingOff": true }));
        self.send(json!({ "type": "control_response", "response": { "subtype": "success", "request_id": init["request_id"], "response": {
            "commands": [], "agents": [], "output_style": "default", "available_output_styles": ["default"],
            "models": list,
            "account": { "email": "user@example.com", "organization": "user@example.com's Organization", "subscriptionType": "Claude Max", "apiProvider": "firstParty" },
            "pid": std::process::id(), "claude_code_version": "2.1.301", "current_permission_mode": "default", "session_state": "idle", "capabilities": []
        } } }));
        self.mcp(json!({ "method": "initialize", "params": { "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": { "name": "claude-code", "version": "2.1.301" } }, "jsonrpc": "2.0", "id": 0 }));
        self.mcp(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
        self.mcp(json!({ "method": "tools/list", "jsonrpc": "2.0", "id": 1 }));
    }

    fn run(&mut self, scenario: &str) {
        loop {
            let user = self.expect("a user message", |v| v["type"] == "user");
            let prompt = user["message"]["content"][0]["text"].as_str().unwrap_or_default().to_owned();
            self.turn_start();
            match scenario {
                "card" => {
                    self.stream(CARD_REPLY, Duration::from_millis(30));
                    self.result_success();
                }
                "slow" => self.slow(),
                "crash" => {
                    self.message_start();
                    self.delta("Working");
                    self.delta(" on it");
                    eprintln!("fake-claude: simulated crash");
                    std::process::exit(1);
                }
                "query" => self.tool_turn("run_query", json!({ "sql": "select count(*) from orders", "purpose": "Count the orders" }), None),
                "query-tampered" => self.tool_turn("run_query", json!({ "sql": "select count(*) from orders", "purpose": "Count the orders" }), Some(json!({ "sql": "select count(*) from customers", "purpose": "Count the orders" }))),
                "describe" => self.tool_turn("describe_tables", json!({ "tables": ["orders"] }), None),
                "echo" => {
                    self.stream(&prompt, Duration::ZERO);
                    self.result_success();
                }
                _ => {
                    self.stream("ok", Duration::ZERO);
                    self.result_success();
                }
            }
        }
    }

    fn turn_start(&mut self) {
        let session = self.session_id.clone();
        self.send(json!({ "type": "system", "subtype": "session_state_changed", "state": "running", "session_id": session }));
        self.send(json!({ "type": "system", "subtype": "init", "cwd": std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default(), "session_id": session, "tools": ["mcp__l1__describe_tables", "mcp__l1__search_catalog", "mcp__l1__run_query"], "mcp_servers": [{ "name": "l1", "status": "connected", "source": "sdk" }], "model": self.model, "permissionMode": "default", "claude_code_version": "2.1.301" }));
        self.send(json!({ "type": "system", "subtype": "status", "status": "requesting", "session_id": session }));
    }

    fn message_start(&mut self) {
        let id = format!("msg_fake_{}", self.next_id());
        self.send(json!({ "type": "stream_event", "event": { "type": "message_start", "message": { "model": self.model, "id": id, "type": "message", "role": "assistant", "content": [], "stop_reason": null } }, "session_id": self.session_id, "parent_tool_use_id": null }));
        self.send(json!({ "type": "stream_event", "event": { "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } }, "session_id": self.session_id, "parent_tool_use_id": null }));
    }

    fn delta(&mut self, text: &str) {
        self.send(json!({ "type": "stream_event", "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": text } }, "session_id": self.session_id, "parent_tool_use_id": null }));
    }

    fn message_end(&mut self, text: &str, stop_reason: &str) {
        self.send(json!({ "type": "assistant", "message": { "model": self.model, "role": "assistant", "content": [{ "type": "text", "text": text }], "stop_reason": null }, "parent_tool_use_id": null, "session_id": self.session_id }));
        self.send(json!({ "type": "stream_event", "event": { "type": "content_block_stop", "index": 0 }, "session_id": self.session_id, "parent_tool_use_id": null }));
        self.send(json!({ "type": "stream_event", "event": { "type": "message_delta", "delta": { "stop_reason": stop_reason, "stop_sequence": null } }, "session_id": self.session_id, "parent_tool_use_id": null }));
        self.send(json!({ "type": "stream_event", "event": { "type": "message_stop" }, "session_id": self.session_id, "parent_tool_use_id": null }));
    }

    /// One text message in deltas of a few characters, `gap` apart.
    fn stream(&mut self, text: &str, gap: Duration) {
        self.message_start();
        let chars: Vec<char> = text.chars().collect();
        for chunk in chars.chunks(DELTA_CHARS) {
            self.delta(&chunk.iter().collect::<String>());
            if !gap.is_zero() {
                std::thread::sleep(gap);
            }
        }
        self.message_end(text, "end_turn");
    }

    fn result_success(&mut self) {
        self.send(json!({ "type": "result", "subtype": "success", "is_error": false, "num_turns": 1, "duration_ms": 10, "result": "", "session_id": self.session_id, "permission_denials": [], "terminal_reason": "completed", "api_error_status": null }));
        self.send(json!({ "type": "system", "subtype": "session_state_changed", "state": "idle", "session_id": self.session_id }));
    }

    fn slow(&mut self) {
        self.message_start();
        let started = Instant::now();
        let mut text = String::new();
        let mut n = 0;
        while started.elapsed() < Duration::from_secs(60) {
            n += 1;
            let piece = format!("tick {n} ");
            text.push_str(&piece);
            self.delta(&piece);
            if let Some(v) = self.poll_line(Duration::from_millis(100))
                && v["request"]["subtype"] == "interrupt"
            {
                self.send(json!({ "type": "control_response", "response": { "subtype": "success", "request_id": v["request_id"], "response": { "still_queued": [] } } }));
                self.send(json!({ "type": "assistant", "message": { "model": self.model, "role": "assistant", "content": [{ "type": "text", "text": text }], "stop_reason": null }, "parent_tool_use_id": null, "session_id": self.session_id, "aborted": true }));
                self.send(json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "text", "text": "[Request interrupted by user]" }] }, "parent_tool_use_id": null, "session_id": self.session_id }));
                self.send(json!({ "type": "result", "subtype": "error_during_execution", "is_error": true, "num_turns": 1, "session_id": self.session_id, "permission_denials": [], "terminal_reason": "aborted_streaming", "errors": ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"] }));
                self.send(json!({ "type": "system", "subtype": "session_state_changed", "state": "idle", "session_id": self.session_id }));
                return;
            }
        }
        self.message_end(&text, "end_turn");
        self.result_success();
    }

    /// One tool call: the `assistant` frame, `can_use_tool`, then `tools/call` when allowed, then
    /// a text message built from the answer.
    fn tool_turn(&mut self, tool: &str, input: Value, call_with: Option<Value>) {
        let tool_use_id = format!("toolu_fake_{}", self.next_id());
        let full_name = format!("mcp__l1__{tool}");
        let msg_id = format!("msg_fake_{}", self.next_id());
        self.send(json!({ "type": "stream_event", "event": { "type": "message_start", "message": { "model": self.model, "id": msg_id, "type": "message", "role": "assistant", "content": [], "stop_reason": null } }, "session_id": self.session_id, "parent_tool_use_id": null }));
        self.send(json!({ "type": "stream_event", "event": { "type": "content_block_start", "index": 0, "content_block": { "type": "tool_use", "id": tool_use_id, "name": full_name, "input": {} } }, "session_id": self.session_id, "parent_tool_use_id": null }));
        self.send(json!({ "type": "assistant", "message": { "model": self.model, "role": "assistant", "content": [{ "type": "tool_use", "id": tool_use_id, "name": full_name, "input": input }], "stop_reason": null }, "parent_tool_use_id": null, "session_id": self.session_id }));
        self.send(json!({ "type": "stream_event", "event": { "type": "content_block_stop", "index": 0 }, "session_id": self.session_id, "parent_tool_use_id": null }));
        self.send(json!({ "type": "stream_event", "event": { "type": "message_delta", "delta": { "stop_reason": "tool_use" } }, "session_id": self.session_id, "parent_tool_use_id": null }));
        self.send(json!({ "type": "stream_event", "event": { "type": "message_stop" }, "session_id": self.session_id, "parent_tool_use_id": null }));
        let ask_id = format!("fake-ask-{}", self.next_id());
        self.send(json!({ "type": "control_request", "request_id": ask_id, "request": { "subtype": "can_use_tool", "tool_name": full_name, "mcp_server": { "name": "l1", "source": "sdk" }, "display_name": tool, "input": input, "permission_suggestions": [], "tool_use_id": tool_use_id } }));
        let answer = self.expect("the permission answer", |v| v["response"]["request_id"] == ask_id);
        let decision = answer["response"]["response"].clone();
        let reply = if decision["behavior"] == "allow" {
            let arguments = call_with.unwrap_or_else(|| decision.get("updatedInput").cloned().unwrap_or(input));
            let call = self.mcp(json!({ "method": "tools/call", "params": { "name": tool, "arguments": arguments, "_meta": { "claudecode/toolUseId": tool_use_id, "progressToken": 2 } }, "jsonrpc": "2.0", "id": 2 }));
            let result = &call["response"]["response"]["mcp_response"]["result"];
            let text = result["content"][0]["text"].as_str().unwrap_or_default();
            let failed = result["isError"] == true;
            self.send(json!({ "type": "user", "message": { "role": "user", "content": [{ "tool_use_id": tool_use_id, "type": "tool_result", "content": text, "is_error": failed }] }, "parent_tool_use_id": null, "session_id": self.session_id }));
            if failed { format!("The tool failed: {text}") } else { format!("The tool returned:\n{text}") }
        } else {
            let message = decision["message"].as_str().unwrap_or_default();
            self.send(json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "tool_result", "content": message, "is_error": true, "tool_use_id": tool_use_id }] }, "parent_tool_use_id": null, "session_id": self.session_id }));
            format!("The call was declined: {message}")
        };
        self.stream(&reply, Duration::ZERO);
        self.result_success();
    }
}

fn capitalize(word: &str) -> String {
    let mut chars = word.chars();
    chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
}

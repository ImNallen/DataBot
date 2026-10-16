//! A stand-in for the `claude` CLI that speaks the frames captured from 2.1.301. The engine tests
//! point `binaryPath` at it and pick a scenario with `launchArgs = --fake-scenario <name>`. Every
//! stdin line and the argv go to `--fake-log <path>` or `$L1_FAKE_CLAUDE_LOG`. Not shipped.

use std::io::{BufRead, Write};
use std::sync::mpsc;

use serde_json::{Value, json};

const VERSION: &str = "2.1.301 (Claude Code)";

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
    if scenario == "resume-lost" && resume.is_some() {
        let id = resume.unwrap();
        println!("{}", json!({ "type": "result", "subtype": "error_during_execution", "is_error": true, "num_turns": 0, "session_id": id, "errors": [format!("No conversation found with session ID: {id}")], "result_index": 0 }));
        eprintln!("No conversation found with session ID: {id}");
        std::process::exit(1);
    }
    let mut cli = Cli { stdin: stdin_lines(), log, next_id: 0 };
    cli.handshake();
    cli.run(&scenario);
}

struct Log(Option<std::fs::File>);

impl Log {
    fn open(args: &[String]) -> Self {
        let path = args.windows(2).find(|w| w[0] == "--fake-log").map(|w| w[1].clone()).or_else(|| std::env::var("L1_FAKE_CLAUDE_LOG").ok());
        Self(path.and_then(|p| std::fs::OpenOptions::new().create(true).append(true).open(p).ok()))
    }

    fn write(&mut self, kind: &str, text: &str) {
        if let Some(file) = self.0.as_mut() {
            let _ = writeln!(file, "{kind}\t{text}");
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
    log: Log,
    next_id: u64,
}

impl Cli {
    fn send(&mut self, frame: Value) {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{frame}");
        let _ = out.flush();
    }

    /// The next stdin line as JSON. EOF ends the process like the real CLI does.
    fn next_line(&mut self) -> Value {
        match self.stdin.recv() {
            Ok(Stdin::Line(line)) => {
                self.log.write("stdin", &line);
                serde_json::from_str(&line).unwrap_or(Value::Null)
            }
            Ok(Stdin::Eof) | Err(_) => std::process::exit(0),
        }
    }

    fn expect(&mut self, what: &str, pick: impl Fn(&Value) -> bool) -> Value {
        loop {
            let v = self.next_line();
            if pick(&v) {
                return v;
            }
            self.log.write("unexpected", &format!("while waiting for {what}: {v}"));
        }
    }

    fn request_id(&mut self) -> String {
        self.next_id += 1;
        format!("fake-req-{}", self.next_id)
    }

    fn mcp(&mut self, message: Value) -> Value {
        let id = self.request_id();
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

    /// Scenarios arrive with the turn loop; until then every session idles until stdin closes.
    fn run(&mut self, _scenario: &str) {
        loop {
            self.next_line();
        }
    }
}

fn capitalize(word: &str) -> String {
    let mut chars = word.chars();
    chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
}

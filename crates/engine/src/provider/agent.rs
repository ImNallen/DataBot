use std::collections::{HashSet, VecDeque};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;

use super::{AgentEvent, Codec, Handshake, LaunchSpec};
use crate::Shared;
use crate::model::{AgentError, TurnOutcome};

const MAX_LINE: usize = 16 << 20;
const STDERR_TAIL: usize = 8 << 10;
const LINE_BUFFER: usize = 256;
const READY_TIMEOUT: Duration = Duration::from_secs(25);
pub(crate) const CLOSE_GRACE: Duration = Duration::from_secs(2);
const EXIT_CODE_WAIT: Duration = Duration::from_secs(2);

/// The process group of every live child, so quit can kill what no task got to close. A group
/// leaves when its child is reaped or swept, so a pid the kernel may have reused is never
/// signalled. Windows has no groups: the id is the child's pid, and the sweep ends that process.
#[derive(Default)]
pub(crate) struct ProcessGroups(Mutex<HashSet<i32>>);

impl ProcessGroups {
    fn insert(&self, pgid: i32) {
        self.0.lock().unwrap().insert(pgid);
    }

    fn remove(&self, pgid: i32) -> bool {
        self.0.lock().unwrap().remove(&pgid)
    }

    pub(crate) fn kill_all(&self) {
        for pgid in self.0.lock().unwrap().drain() {
            kill_group(pgid);
        }
    }
}

pub(crate) struct Agent {
    pub codec: Box<dyn Codec>,
    child: Child,
    /// The child's process group, which equals its pid: `process_group(0)` at spawn.
    pgid: i32,
    groups: Arc<ProcessGroups>,
    stdin: Option<ChildStdin>,
    lines: mpsc::Receiver<Line>,
    outbox: Vec<u8>,
    pending: VecDeque<AgentEvent>,
    stderr: Arc<Mutex<String>>,
    eof: bool,
}

enum Line {
    Out(String),
    Eof,
}

pub(crate) enum Next {
    Event(AgentEvent),
    Flush,
    Eof { code: Option<i32> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StartError {
    NotFound { binary: String },
    Exited { code: Option<i32>, detail: String },
    Reported(AgentError),
    Timeout,
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartError::NotFound { binary } | StartError::Reported(AgentError::NotFound { binary }) => write!(f, "{binary} not found"),
            StartError::Exited { code: Some(code), detail } => write!(f, "exited with code {code}: {}", detail.trim()),
            StartError::Exited { code: None, detail } | StartError::Reported(AgentError::Exited { detail, .. }) => write!(f, "exited: {}", detail.trim()),
            StartError::Reported(AgentError::SignedOut) => write!(f, "signed out"),
            StartError::Reported(AgentError::Provider { message }) => write!(f, "{message}"),
            StartError::Timeout => write!(f, "no answer to the handshake within {} s", READY_TIMEOUT.as_secs()),
        }
    }
}

impl Agent {
    /// Spawns `spec`, writes `codec.open()`, and waits for `AgentEvent::Ready`. Lines that arrive
    /// before it go through the codec like any other; the CLI sent its first MCP message 4 ms
    /// before answering `initialize`, so the reader never waits on a request the host has in flight.
    pub(crate) async fn start(shared: &Shared, spec: LaunchSpec, codec: Box<dyn Codec>) -> Result<(Agent, Handshake), StartError> {
        // Spawning into a missing directory fails with the same NotFound as a missing binary.
        if !spec.cwd.is_dir() {
            return Err(StartError::Exited { code: None, detail: format!("the assistant's working directory {} is missing", spec.cwd.display()) });
        }
        let mut command = Command::new(&spec.program);
        command.args(&spec.args).current_dir(&spec.cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        for key in &spec.env_remove {
            command.env_remove(key);
        }
        for (key, value) in &spec.env_set {
            command.env(key, value);
        }
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => StartError::NotFound { binary: spec.program.display().to_string() },
            _ => StartError::Exited { code: None, detail: e.to_string() },
        })?;
        let pgid = child.id().expect("a child not yet waited on has a pid") as i32;
        shared.process_groups.insert(pgid);
        let stdout = child.stdout.take().expect("piped");
        let stderr_pipe = child.stderr.take().expect("piped");
        let stdin = child.stdin.take().expect("piped");
        let (tx, lines) = mpsc::channel(LINE_BUFFER);
        shared.spawn(async move {
            let mut reader = BufReader::with_capacity(64 << 10, stdout);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) if buf.len() > MAX_LINE => continue,
                    Ok(_) => {
                        let text = String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_owned();
                        if tx.send(Line::Out(text)).await.is_err() {
                            return;
                        }
                    }
                }
            }
            let _ = tx.send(Line::Eof).await;
        });
        let stderr = Arc::new(Mutex::new(String::new()));
        let tail = stderr.clone();
        shared.spawn(async move {
            let mut reader = stderr_pipe;
            let mut chunk = [0u8; 4096];
            while let Ok(n) = reader.read(&mut chunk).await
                && n > 0
            {
                let mut text = tail.lock().unwrap();
                text.push_str(&String::from_utf8_lossy(&chunk[..n]));
                if text.len() > STDERR_TAIL {
                    let cut = text.len() - STDERR_TAIL;
                    let cut = text.char_indices().find(|(i, _)| *i >= cut).map_or(text.len(), |(i, _)| i);
                    text.drain(..cut);
                }
            }
        });
        let mut agent = Agent { codec, child, pgid, groups: shared.process_groups.clone(), stdin: Some(stdin), lines, outbox: Vec::new(), pending: VecDeque::new(), stderr, eof: false };
        let open = agent.codec.open();
        if let Err(e) = agent.write(open).await {
            let code = agent.exit_code().await;
            return Err(StartError::Exited { code, detail: agent.failure_detail(&e.to_string()) });
        }
        let mut early = VecDeque::new();
        let ready = tokio::time::timeout(READY_TIMEOUT, async {
            loop {
                match agent.next().await {
                    Next::Event(AgentEvent::Ready(handshake)) => return Ok(handshake),
                    Next::Event(AgentEvent::TurnEnded(TurnOutcome::Failed { error })) => {
                        let _ = agent.exit_code().await;
                        return Err(StartError::Reported(error));
                    }
                    Next::Event(other) => early.push_back(other),
                    Next::Flush => {}
                    Next::Eof { code } => return Err(StartError::Exited { code, detail: agent.failure_detail("") }),
                }
                if let Err(e) = agent.flush().await {
                    let code = agent.exit_code().await;
                    return Err(StartError::Exited { code, detail: agent.failure_detail(&e.to_string()) });
                }
            }
        })
        .await;
        match ready {
            Ok(Ok(handshake)) => {
                early.append(&mut agent.pending);
                agent.pending = early;
                Ok((agent, handshake))
            }
            Ok(Err(e)) => Err(e),
            Err(_) => Err(StartError::Timeout),
        }
    }

    fn failure_detail(&self, fallback: &str) -> String {
        let tail = self.stderr_tail();
        if tail.trim().is_empty() { fallback.to_owned() } else { tail }
    }

    pub(crate) async fn next(&mut self) -> Next {
        loop {
            if let Some(event) = self.pending.pop_front() {
                return Next::Event(event);
            }
            if self.eof {
                return Next::Eof { code: self.exit_code().await };
            }
            match self.lines.recv().await {
                Some(Line::Out(line)) => {
                    let step = self.codec.read(&line);
                    let answered = !step.replies.is_empty();
                    self.queue(step.replies);
                    self.pending.extend(step.events);
                    if answered && self.pending.is_empty() {
                        return Next::Flush;
                    }
                }
                Some(Line::Eof) | None => self.eof = true,
            }
        }
    }

    pub(crate) async fn write(&mut self, lines: Vec<String>) -> std::io::Result<()> {
        self.queue(lines);
        self.flush().await
    }

    fn queue(&mut self, lines: Vec<String>) {
        for line in lines {
            self.outbox.extend_from_slice(line.as_bytes());
            self.outbox.push(b'\n');
        }
    }

    pub(crate) async fn flush(&mut self) -> std::io::Result<()> {
        if self.outbox.is_empty() {
            return Ok(());
        }
        let stdin = self.stdin.as_mut().expect("only `close` takes stdin, and it consumes the agent");
        while !self.outbox.is_empty() {
            let written = stdin.write(&self.outbox).await?;
            if written == 0 {
                return Err(std::io::ErrorKind::WriteZero.into());
            }
            self.outbox.drain(..written);
        }
        stdin.flush().await
    }

    pub(crate) fn stderr_tail(&self) -> String {
        self.stderr.lock().unwrap().clone()
    }

    async fn exit_code(&mut self) -> Option<i32> {
        let status = tokio::time::timeout(EXIT_CODE_WAIT, self.child.wait()).await.ok().and_then(Result::ok)?;
        self.groups.remove(self.pgid);
        status.code()
    }

    pub(crate) async fn close(mut self) {
        drop(self.stdin.take());
        if tokio::time::timeout(CLOSE_GRACE, self.child.wait()).await.is_err() {
            if self.groups.remove(self.pgid) {
                kill_group(self.pgid);
            }
            // The group kill also reaches the child's descendants; this reaches the child on every platform.
            let _ = self.child.start_kill();
            let _ = self.child.wait().await;
        }
        self.groups.remove(self.pgid);
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        if self.groups.remove(self.pgid) {
            kill_group(self.pgid);
        }
    }
}

#[cfg(unix)]
fn kill_group(pgid: i32) {
    if pgid > 0 {
        // SAFETY: killpg has no memory-safety preconditions; a stale pgid fails with ESRCH.
        unsafe {
            libc::killpg(pgid, libc::SIGKILL);
        }
    }
}

/// Windows has no process group to signal, so the registered process itself is ended.
#[cfg(windows)]
fn kill_group(pid: i32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE, TerminateProcess};
    // SAFETY: the handle OpenProcess returns is closed here, and a stale pid yields a null handle.
    unsafe {
        let process = OpenProcess(PROCESS_TERMINATE, 0, pid as u32);
        if !process.is_null() {
            TerminateProcess(process, 1);
            CloseHandle(process);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::pin::Pin;
    use std::task::{Context, Poll, Waker};

    use serde_json::Value;

    use super::*;
    use crate::model::Decision;
    use crate::provider::{BlockKey, ModelResult, ReplyTo, Step};
    use crate::{AgentPath, Engine, EngineConfig, MemoryKeyStore};

    struct LineCodec;

    impl Codec for LineCodec {
        fn open(&mut self) -> Vec<String> {
            Vec::new()
        }

        fn user_turn(&mut self, text: &str) -> Vec<String> {
            vec![text.to_owned()]
        }

        fn interrupt(&mut self) -> Vec<String> {
            Vec::new()
        }

        fn permission(&mut self, _: &ReplyTo, _: Decision, _: &Value, _: &str) -> Vec<String> {
            Vec::new()
        }

        fn tool_result(&mut self, _: &ReplyTo, _: &ModelResult) -> Vec<String> {
            Vec::new()
        }

        fn read(&mut self, line: &str) -> Step {
            let event = match line {
                "ready" => AgentEvent::Ready(Handshake { version: None, plan: None, models: Vec::new() }),
                _ => AgentEvent::Text { block: BlockKey { message: 0, index: 0 }, delta: line.to_owned() },
            };
            Step { replies: Vec::new(), events: vec![event] }
        }
    }

    fn poll_once<F: Future + Unpin>(fut: &mut F) -> Poll<F::Output> {
        Pin::new(fut).poll(&mut Context::from_waker(Waker::noop()))
    }

    /// Polls a fresh `next` once per step and drops it while it is pending, so every value
    /// arrives through a future whose predecessors were cancelled mid-await.
    async fn next_cancelling(agent: &mut Agent, cancelled: &mut usize) -> Next {
        loop {
            let mut fut = Box::pin(agent.next());
            if let Poll::Ready(next) = poll_once(&mut fut) {
                return next;
            }
            drop(fut);
            *cancelled += 1;
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }

    async fn texts_until(agent: &mut Agent, cancelled: &mut usize, count: usize) -> Vec<String> {
        let mut out = Vec::new();
        while out.len() < count {
            match next_cancelling(agent, cancelled).await {
                Next::Event(AgentEvent::Text { delta, .. }) => out.push(delta),
                Next::Event(_) | Next::Flush => {}
                Next::Eof { code } => panic!("eof with code {code:?} after {} of {count} lines", out.len()),
            }
        }
        out
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn close_ends_a_child_that_ignores_eof_even_with_no_group_to_kill() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(EngineConfig { data_dir: dir.path().to_owned(), keys: Arc::new(MemoryKeyStore::default()), agent_path: AgentPath::Fixed("".into()) }).await.unwrap();
        let spec = LaunchSpec { program: "sh".into(), args: vec!["-c".into(), "echo ready; exec sleep 60".into()], env_set: Vec::new(), env_remove: Vec::new(), cwd: std::env::temp_dir() };
        let (agent, _) = Agent::start(&engine.shared, spec, Box::new(LineCodec)).await.unwrap();
        let pid = agent.pgid;
        assert!(agent.groups.remove(pid), "the group was registered at spawn");
        tokio::time::timeout(CLOSE_GRACE + Duration::from_secs(3), agent.close()).await.expect("close waited on a child that nothing killed");
        // SAFETY: signal 0 only asks whether the process exists.
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "process {pid} outlived close");
    }

    #[tokio::test]
    async fn a_cancelled_next_or_flush_loses_no_line_no_eof_and_no_write() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(EngineConfig { data_dir: dir.path().to_owned(), keys: Arc::new(MemoryKeyStore::default()), agent_path: AgentPath::Fixed("".into()) }).await.unwrap();
        let script = "echo ready; echo one; sleep 0.2; echo two; sleep 0.5; cat";
        let spec = LaunchSpec { program: "sh".into(), args: vec!["-c".into(), script.into()], env_set: Vec::new(), env_remove: Vec::new(), cwd: std::env::temp_dir() };
        let (mut agent, _) = Agent::start(&engine.shared, spec, Box::new(LineCodec)).await.unwrap();
        let mut cancelled = 0;
        assert_eq!(texts_until(&mut agent, &mut cancelled, 2).await, ["one", "two"]);
        assert!(cancelled > 0, "no next was pending, so none was cancelled");

        let payload: Vec<String> = (0..100).map(|i| format!("{i:03}{}", "x".repeat(4096))).collect();
        agent.queue(payload.clone());
        let mut flush = Box::pin(agent.flush());
        assert!(poll_once(&mut flush).is_pending(), "the pipe took 400 KB at once, so no write was cancelled");
        drop(flush);
        agent.flush().await.unwrap();
        drop(agent.stdin.take());
        let echoed = tokio::time::timeout(Duration::from_secs(10), texts_until(&mut agent, &mut cancelled, payload.len())).await.expect("cat echoed every line");
        assert_eq!(echoed, payload);

        let mut eof = 0;
        let first = next_cancelling(&mut agent, &mut eof).await;
        let again = next_cancelling(&mut agent, &mut eof).await;
        assert!(matches!((&first, &again), (Next::Eof { code: Some(0) }, Next::Eof { code: Some(0) })), "the end of stream is reported on every call after it");
    }
}

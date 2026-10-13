//! The bridge's command table: the same names and camelCase argument keys as the Tauri commands.

use std::any::Any;
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;

use engine::Engine;
use engine::model::*;
use futures_util::FutureExt;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

/// What the command itself returned: `Ok(data)` or its typed error value.
pub type Reply = Result<Value, Value>;

#[derive(Debug)]
pub enum BridgeError {
    UnknownCommand(String),
    BadArg { arg: String, message: String },
    Panicked(String),
}

/// Lets commands that cannot fail share the `Result` path with those that can.
#[derive(Serialize)]
enum Never {}

fn ok<T>(value: T) -> Result<T, Never> {
    Ok(value)
}

fn reply<T: Serialize, E: Serialize>(result: Result<T, E>) -> Reply {
    match result {
        Ok(data) => Ok(json(data)),
        Err(error) => Err(json(error)),
    }
}

fn json(value: impl Serialize) -> Value {
    serde_json::to_value(value).expect("IPC types serialize to JSON")
}

/// Tauri maps a snake_case parameter to a camelCase key; a missing key reads as `null`.
fn take<T: DeserializeOwned>(args: &mut Map<String, Value>, param: &str) -> Result<T, BridgeError> {
    let key = camel_case(param);
    let value = args.remove(&key).unwrap_or(Value::Null);
    serde_json::from_value(value).map_err(|e| BridgeError::BadArg {
        arg: key,
        message: e.to_string(),
    })
}

pub fn camel_case(snake: &str) -> String {
    let mut out = String::with_capacity(snake.len());
    let mut upper = false;
    for c in snake.chars() {
        match (c, upper) {
            ('_', _) => upper = true,
            (c, true) => {
                out.extend(c.to_uppercase());
                upper = false;
            }
            (c, false) => out.push(c),
        }
    }
    out
}

fn panic_message(payload: Box<dyn Any + Send>) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "panic".into())
}

macro_rules! routes {
    ($engine:ident; $( $name:ident ( $( $arg:ident : $ty:ty ),* ) => $call:expr; )*) => {
        /// Every served command with its Rust parameter names, in registration order.
        #[cfg(test)]
        pub const ROUTES: &[(&str, &[&str])] = &[ $( (stringify!($name), &[ $( stringify!($arg) ),* ]) ),* ];

        pub async fn dispatch(
            $engine: &Engine,
            cmd: &str,
            mut args: Map<String, Value>,
        ) -> Result<Reply, BridgeError> {
            let run = async {
                match cmd {
                    $( stringify!($name) => {
                        $( let $arg: $ty = take(&mut args, stringify!($arg))?; )*
                        Ok(reply($call))
                    } )*
                    _ => Err(BridgeError::UnknownCommand(cmd.to_owned())),
                }
            };
            AssertUnwindSafe(run)
                .catch_unwind()
                .await
                .unwrap_or_else(|p| Err(BridgeError::Panicked(panic_message(p))))
        }
    };
}

routes! { e;
    app_boot() => ok(e.boot());
    connection_save(draft: ConnectionDraft) => e.save_connection(draft).await;
    connection_delete(id: ConnectionId) => e.delete_connection(id).await;
    connection_test(draft: ConnectionDraft) => e.test_connection(draft).await;
    connection_connect(id: ConnectionId) => e.connect(id).await;
    connection_disconnect(id: ConnectionId, force: bool) => e.disconnect(id, force).await;
    catalog_get(id: ConnectionId) => e.catalog(id);
    catalog_refresh(id: ConnectionId) => e.refresh_catalog(id).await;
    console_configure(tab_id: TabId, config: ConsoleConfig) => e.console_configure(tab_id, config).await;
    console_run(tab_id: TabId, request: RunRequest) => e.console_run(tab_id, request).await;
    console_cancel(tab_id: TabId) => { e.console_cancel(tab_id).await; ok(()) };
    console_commit(tab_id: TabId) => e.console_commit(tab_id).await;
    console_rollback(tab_id: TabId) => e.console_rollback(tab_id).await;
    console_close(tab_id: TabId, force: bool) => e.console_close(tab_id, force).await;
    result_page(result_ref: ResultRef, start: u32, len: u32) => e.result_page(result_ref, start, len);
    result_cell(result_ref: ResultRef, row: u32, col: u16) => e.result_cell(result_ref, row, col);
    result_export_csv(result_ref: ResultRef, path: String) => e.export_csv(result_ref, PathBuf::from(path)).await;
    history_list(query: HistoryQuery) => ok(e.history(query));
    history_clear() => { e.clear_history(); ok(()) };
    workspace_save(workspace: Workspace) => { e.save_workspace(workspace); ok(()) };
    settings_set(settings: Settings) => { e.set_settings(settings); ok(()) };
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Arc;

    use engine::{EngineConfig, MemorySecrets};
    use serde_json::json;

    use super::*;

    const BINDINGS: &str = include_str!("../../../src/ipc/bindings.ts");

    /// `{ command: [camelCase arg, ...] }` from each `__TAURI_INVOKE("name", { a, b })` call
    /// in the generated bindings, which the drift test proves match the Tauri registration.
    fn tauri_commands() -> BTreeMap<String, Vec<String>> {
        BINDINGS
            .lines()
            .filter_map(|line| {
                let call = &line[line.find("__TAURI_INVOKE")?..];
                let name_start = call.find("(\"")? + 2;
                let name_end = name_start + call[name_start..].find('"')?;
                let rest = &call[name_end + 1..];
                let args = match rest.strip_prefix(", { ") {
                    Some(list) => list[..list.find(" }")?].split(", ").map(String::from).collect(),
                    None => Vec::new(),
                };
                Some((call[name_start..name_end].to_owned(), args))
            })
            .collect()
    }

    #[test]
    fn dispatch_serves_exactly_the_tauri_commands() {
        let bridge: BTreeMap<String, Vec<String>> = ROUTES
            .iter()
            .map(|(name, params)| (name.to_string(), params.iter().map(|p| camel_case(p)).collect()))
            .collect();
        let tauri = tauri_commands();
        assert!(tauri.contains_key("console_run"), "parsed no commands from bindings.ts");
        assert_eq!(bridge, tauri);
    }

    async fn engine() -> (Arc<Engine>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(EngineConfig {
            data_dir: dir.path().to_owned(),
            secrets: Arc::new(MemorySecrets::default()),
        })
        .await
        .unwrap();
        (engine, dir)
    }

    #[tokio::test]
    async fn app_boot_replies_with_the_snapshot() {
        let (engine, _dir) = engine().await;
        let reply = dispatch(&engine, "app_boot", Map::new()).await.unwrap().unwrap();
        assert_eq!(reply["workspace"]["tabs"], json!([]));
        assert_eq!(reply["settings"]["maxRows"], json!(200_000));
    }

    #[tokio::test]
    async fn bad_requests_are_bridge_errors_not_command_errors() {
        let (engine, _dir) = engine().await;
        assert!(matches!(
            dispatch(&engine, "nope", Map::new()).await,
            Err(BridgeError::UnknownCommand(_))
        ));
        let args = json!({ "tabId": "not-a-uuid" }).as_object().unwrap().clone();
        assert!(matches!(
            dispatch(&engine, "console_cancel", args).await,
            Err(BridgeError::BadArg { arg, .. }) if arg == "tabId"
        ));
        assert!(matches!(
            dispatch(&engine, "history_clear", Map::new()).await,
            Err(BridgeError::Panicked(m)) if m.contains("not yet implemented")
        ));
    }
}

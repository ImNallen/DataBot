use std::any::Any;
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;

use engine::Engine;
use engine::model::*;
use futures_util::FutureExt;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

pub type Reply = Result<Value, Value>;

#[derive(Debug)]
pub enum BridgeError {
    UnknownCommand(String),
    BadArg { arg: String, message: String },
    Panicked(String),
}

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
    connection_parse_url(url: String) => e.parse_connection_url(&url);
    connection_connect(id: ConnectionId) => e.connect(id).await;
    connection_disconnect(id: ConnectionId, force: bool) => e.disconnect(id, force).await;
    catalog_get(db: DatabaseRef) => e.catalog(db).await;
    catalog_refresh(db: DatabaseRef) => e.refresh_catalog(db).await;
    connection_refresh(id: ConnectionId) => e.refresh_connection(id).await;
    connection_edit_view(id: ConnectionId, edit: ViewEdit) => e.edit_view(id, edit).await;
    connection_probe_databases(id: ConnectionId, databases: Vec<String>) => { e.probe_databases(id, databases); ok(()) };
    relation_detail(db: DatabaseRef, oid: u32) => e.relation_detail(db, oid).await;
    exact_row_count(db: DatabaseRef, schema: String, table: String, query: TableQuery) => e.exact_row_count(db, schema, table, query).await;
    console_configure(tab_id: TabId, config: ConsoleConfig) => e.console_configure(tab_id, config).await;
    script_outline(text: String, cursor: DocOffset) => ok(e.script_outline(&text, cursor));
    console_run(tab_id: TabId, request: RunRequest) => e.console_run(tab_id, request).await;
    console_cancel(tab_id: TabId) => { e.console_cancel(tab_id).await; ok(()) };
    console_commit(tab_id: TabId) => e.console_commit(tab_id).await;
    console_rollback(tab_id: TabId) => e.console_rollback(tab_id).await;
    table_apply(tab_id: TabId, changes: TableChanges) => e.table_apply(tab_id, changes).await;
    console_close(tab_id: TabId, force: bool) => e.console_close(tab_id, force).await;
    result_page(result_ref: ResultRef, start: u32, len: u32) => e.result_page(result_ref, start, len);
    result_cell(result_ref: ResultRef, row: u32, col: u16) => e.result_cell(result_ref, row, col);
    result_export_csv(result_ref: ResultRef, path: String) => e.export_csv(result_ref, PathBuf::from(path)).await;
    history_list(query: HistoryQuery) => ok(e.history(query));
    history_browse(query: HistoryBrowseQuery) => e.history_browse(query);
    history_group(query: HistoryGroupQuery) => e.history_group(query);
    history_clear() => { e.clear_history(); ok(()) };
    workspace_save(workspace: Workspace) => { e.save_workspace(workspace); ok(()) };
    settings_set(settings: Settings) => { e.set_settings(settings); ok(()) };
    assistant_open(chat_id: ChatId) => e.assistant_open(chat_id).await;
    assistant_configure(chat_id: ChatId, options: ChatOptions) => e.assistant_configure(chat_id, options);
    assistant_send(chat_id: ChatId, request: SendRequest) => e.assistant_send(chat_id, request).await;
    assistant_stop(chat_id: ChatId) => { e.assistant_stop(chat_id); ok(()) };
    assistant_approve(chat_id: ChatId, approval: ApprovalId, decision: Decision) => e.assistant_approve(chat_id, approval, decision);
    assistant_delete(chat_id: ChatId) => { e.assistant_delete(chat_id).await; ok(()) };
    provider_refresh() => { e.provider_refresh(); ok(()) };
    usage_limits() => ok(e.usage_limits().await);
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Arc;

    use engine::{AgentPath, EngineConfig, MemoryKeyStore};
    use serde_json::json;

    use super::*;

    const BINDINGS: &str = include_str!("../../../src/ipc/bindings.ts");

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
            keys: Arc::new(MemoryKeyStore::default()),
            agent_path: AgentPath::Fixed("".into()),
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
        let unknown = json!({ "db": { "connectionId": "00000000-0000-0000-0000-000000000000", "database": "shop" } }).as_object().unwrap().clone();
        let reply = dispatch(&engine, "catalog_get", unknown).await.unwrap();
        assert_eq!(reply.unwrap_err(), json!({ "kind": "NotConnected" }), "a typed error is a command error");
    }
}

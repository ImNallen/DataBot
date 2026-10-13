#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ipc;

use std::error::Error;
use std::path::Path;
use std::sync::Arc;

use engine::model::AppEvent;
use engine::{Engine, EngineConfig, KeyringSecrets, MemorySecrets, SecretStore};
use specta_typescript::Typescript;
use tauri::{AppHandle, Emitter, Manager, WebviewWindowBuilder};
use tokio::sync::broadcast::{self, error::RecvError};

const BINDINGS_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/ipc/bindings.ts");

fn specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            ipc::app_boot,
            ipc::connection_save,
            ipc::connection_delete,
            ipc::connection_test,
            ipc::connection_connect,
            ipc::connection_disconnect,
            ipc::catalog_get,
            ipc::catalog_refresh,
            ipc::console_configure,
            ipc::console_run,
            ipc::console_cancel,
            ipc::console_commit,
            ipc::console_rollback,
            ipc::console_close,
            ipc::result_page,
            ipc::result_cell,
            ipc::result_export_csv,
            ipc::history_list,
            ipc::history_clear,
            ipc::workspace_save,
            ipc::settings_set,
        ])
        .typ::<AppEvent>()
        // Row counts, revs, and epoch millis stay far below 2^53.
        .dangerously_cast_bigints_to_number()
}

fn export_bindings(builder: &tauri_specta::Builder<tauri::Wry>, path: &Path) {
    builder
        .export(Typescript::default(), path)
        .expect("failed to export TypeScript bindings");
}

/// Debug builds honor dev and test overrides; release builds ignore the environment.
fn debug_env(key: &str) -> Option<String> {
    if cfg!(debug_assertions) { std::env::var(key).ok() } else { None }
}

fn engine_config(app: &tauri::App) -> Result<EngineConfig, Box<dyn Error>> {
    let data_dir = match debug_env("DATABOT_DATA_DIR") {
        Some(dir) => dir.into(),
        None => app.path().app_data_dir()?,
    };
    let secrets: Arc<dyn SecretStore> = match debug_env("DATABOT_SECRET_STORE").as_deref() {
        Some("memory") => Arc::new(MemorySecrets::default()),
        _ => Arc::new(KeyringSecrets),
    };
    Ok(EngineConfig { data_dir, secrets })
}

fn forward_events(app: AppHandle, mut events: broadcast::Receiver<AppEvent>) {
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(ev) => {
                    if let Err(e) = app.emit("app-event", ev) {
                        eprintln!("app-event emit failed: {e}");
                    }
                }
                Err(RecvError::Lagged(n)) => eprintln!("app-event forwarder dropped {n} events"),
                Err(RecvError::Closed) => break,
            }
        }
    });
}

/// `DATABOT_SELF_CHECK=1`: boot the engine inside Tauri, print a JSON report, exit.
async fn self_check(app: AppHandle, engine: Arc<Engine>) {
    // Connecting, `SELECT 1`, and the catalog load arrive with the engine phase; until then
    // the report says so and the check fails.
    let report = serde_json::json!({
        "ok": false,
        "dataDir": engine.data_dir(),
        "boot": engine.boot(),
        "connect": { "status": "notImplemented" },
    });
    println!("{report}");
    app.exit(1);
}

fn main() {
    let builder = specta_builder();
    #[cfg(debug_assertions)]
    export_bindings(&builder, Path::new(BINDINGS_PATH));

    let self_checking = std::env::var("DATABOT_SELF_CHECK").as_deref() == Ok("1");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            let engine = tauri::async_runtime::block_on(Engine::open(engine_config(app)?))?;
            app.manage(engine.clone());
            if self_checking {
                tauri::async_runtime::spawn(self_check(app.handle().clone(), engine));
                return Ok(());
            }
            forward_events(app.handle().clone(), engine.subscribe());
            WebviewWindowBuilder::from_config(app.handle(), &app.config().app.windows[0])?.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running DataBot");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_bindings_up_to_date() {
        let fresh_path = std::env::temp_dir().join(format!("databot-bindings-{}.ts", std::process::id()));
        export_bindings(&specta_builder(), &fresh_path);
        let fresh = std::fs::read_to_string(&fresh_path).unwrap();
        std::fs::remove_file(&fresh_path).unwrap();
        if std::env::var_os("UPDATE_BINDINGS").is_some() {
            std::fs::write(BINDINGS_PATH, &fresh).unwrap();
        }
        let committed = std::fs::read_to_string(BINDINGS_PATH).unwrap_or_default();
        assert!(
            fresh == committed,
            "src/ipc/bindings.ts is stale; run `pnpm bindings` and commit the result"
        );
    }
}

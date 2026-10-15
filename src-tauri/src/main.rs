#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ipc;

use std::error::Error;
use std::path::Path;
use std::sync::Arc;

use engine::model::{AppEvent, ColorScheme};
use engine::{Engine, EngineConfig, KeyStore, KeyringKeyStore, MemoryKeyStore};
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
            ipc::connection_refresh,
            ipc::connection_edit_view,
            ipc::connection_probe_databases,
            ipc::relation_detail,
            ipc::exact_row_count,
            ipc::console_configure,
            ipc::console_run,
            ipc::console_cancel,
            ipc::console_commit,
            ipc::console_rollback,
            ipc::table_apply,
            ipc::console_close,
            ipc::result_page,
            ipc::result_cell,
            ipc::result_export_csv,
            ipc::history_list,
            ipc::history_browse,
            ipc::history_group,
            ipc::history_clear,
            ipc::workspace_save,
            ipc::settings_set,
        ])
        .typ::<AppEvent>()
        .dangerously_cast_bigints_to_number()
}

fn export_bindings(builder: &tauri_specta::Builder<tauri::Wry>, path: &Path) {
    builder
        .export(Typescript::default(), path)
        .expect("failed to export TypeScript bindings");
}

fn debug_env(key: &str) -> Option<String> {
    if cfg!(debug_assertions) { std::env::var(key).ok() } else { None }
}

fn engine_config(app: &tauri::App) -> Result<EngineConfig, Box<dyn Error>> {
    let data_dir = match debug_env("L1_DATA_DATA_DIR") {
        Some(dir) => dir.into(),
        None => app.path().app_data_dir()?,
    };
    let keys: Arc<dyn KeyStore> = match debug_env("L1_DATA_SECRET_STORE").as_deref() {
        Some("memory") => Arc::new(MemoryKeyStore::default()),
        _ => Arc::new(KeyringKeyStore),
    };
    Ok(EngineConfig { data_dir, keys })
}

// Tauri's default macOS menu binds Cmd+W to Close Window, which would swallow the key before the webview's
// close-tab shortcut sees it. This mirrors that menu with Close Window moved to Shift+Cmd+W.
#[cfg(target_os = "macos")]
fn macos_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
    let close_window = || MenuItem::with_id(app, CLOSE_WINDOW, "Close Window", true, Some("Shift+CmdOrCtrl+W"));
    let about = AboutMetadata { name: Some(app.package_info().name.clone()), version: Some(app.package_info().version.to_string()), ..Default::default() };
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                app.package_info().name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(app, "File", true, &[&close_window()?])?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &close_window()?,
                ],
            )?,
        ],
    )
}

#[cfg(target_os = "macos")]
const CLOSE_WINDOW: &str = "close-window";

const LIGHT_BACKGROUND: tauri::window::Color = tauri::window::Color(255, 255, 255, 255);

fn window_theme(scheme: ColorScheme) -> Option<tauri::Theme> {
    match scheme {
        ColorScheme::System => None,
        ColorScheme::Light => Some(tauri::Theme::Light),
        ColorScheme::Dark => Some(tauri::Theme::Dark),
    }
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

const SELF_CHECK_URL: &str = "postgres://l1data:l1data@localhost:5433/shop";

async fn self_check(app: AppHandle, engine: Arc<Engine>) {
    let url = std::env::var("L1_DATA_SELF_CHECK_URL").unwrap_or_else(|_| SELF_CHECK_URL.into());
    let data_dir = engine.data_dir().to_owned();
    let (ok, report) = match self_check_steps(&engine, &url).await {
        Ok(report) => (true, report),
        Err((step, error)) => (false, serde_json::json!({ "step": step, "error": error })),
    };
    println!("{}", serde_json::json!({ "ok": ok, "dataDir": data_dir, "report": report }));
    app.exit(if ok { 0 } else { 1 });
}

async fn self_check_steps(engine: &Arc<Engine>, url: &str) -> Result<serde_json::Value, (&'static str, serde_json::Value)> {
    use engine::model::*;
    fn fail<E: serde::Serialize>(step: &'static str) -> impl FnOnce(E) -> (&'static str, serde_json::Value) {
        move |e| (step, serde_json::to_value(e).expect("IPC types serialize to JSON"))
    }
    let draft = engine::draft_from_url(url, "self-check").map_err(fail("parse_url"))?;
    let config = engine.save_connection(draft).await.map_err(fail("connection_save"))?;
    let mut events = engine.subscribe();
    let server = engine.connect(config.id).await.map_err(fail("connection_connect"))?;
    let tab = TabId(uuid::Uuid::new_v4());
    engine
        .console_configure(tab, ConsoleConfig { connection_id: config.id, database: config.database.clone(), schema: None, mode: TxnMode::AutoCommit })
        .await
        .map_err(fail("console_configure"))?;
    let accepted = engine
        .console_run(tab, RunRequest::Script { text: "SELECT 1".into(), target: RunTarget::All })
        .await
        .map_err(fail("console_run"))?;
    let finished = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            match events.recv().await {
                Ok(AppEvent::ConsoleChanged(ConsoleState { tab_id, run: RunState::Finished { run_id, outcome, elapsed_ms, .. }, .. }))
                    if tab_id == tab && run_id == accepted.run_id => return Ok((outcome, elapsed_ms)),
                Ok(_) => {}
                Err(e) => return Err(e.to_string()),
            }
        }
    })
    .await
    .map_err(|_| ("console_run", serde_json::json!("no Finished event within 30s")))?
    .map_err(fail("console_run"))?;
    if finished.0 != RunOutcome::Ok {
        return Err(("console_run", serde_json::json!({ "outcome": finished.0 })));
    }
    let page = engine
        .result_page(ResultRef { tab_id: tab, run_id: accepted.run_id, index: 0 }, 0, 1)
        .map_err(fail("result_page"))?;
    let catalog = engine.catalog(DatabaseRef { connection_id: config.id, database: config.database.clone() }).await.map_err(fail("catalog_get"))?;
    engine
        .edit_view(config.id, ViewEdit::Database { name: "reporting".into(), shown: true })
        .await
        .map_err(fail("connection_edit_view"))?;
    let reporting = engine.catalog(DatabaseRef { connection_id: config.id, database: "reporting".into() }).await.map_err(fail("catalog_get reporting"))?;
    // Called from a plain thread, as the sync command is on the main thread of the desktop app.
    let prober = engine.clone();
    let id = config.id;
    std::thread::spawn(move || prober.probe_databases(id, vec!["postgres".into()]))
        .join()
        .map_err(|_| ("connection_probe_databases", serde_json::json!("panicked off the runtime")))?;
    let probed = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let live = engine.boot().live.into_iter().find(|c| c.id == config.id);
            if let Some(ConnectionState { status: ConnStatus::Connected { instance, .. }, .. }) = live
                && let Some(db) = instance.databases.iter().find(|d| d.name == "postgres")
                && let SchemaCount::Known { count } = db.schema_count
            {
                return count;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| ("connection_probe_databases", serde_json::json!("no Known count within 10s")))?;
    let report = |c: &Catalog| {
        serde_json::json!({
            "version": c.version,
            "database": c.db.database,
            "defaultSchema": c.default_schema,
            "schemas": c.schemas.iter().map(|s| serde_json::json!({
                "name": s.name, "system": s.system, "relations": s.relations.len(), "functions": s.functions.len(),
            })).collect::<Vec<_>>(),
        })
    };
    Ok(serde_json::json!({
        "server": server,
        "select1": { "rows": page.rows, "elapsedMs": finished.1 },
        "catalog": report(&catalog),
        "shownCatalog": report(&reporting),
        "probedSchemas": { "postgres": probed },
    }))
}

fn main() {
    let builder = specta_builder();
    #[cfg(debug_assertions)]
    export_bindings(&builder, Path::new(BINDINGS_PATH));

    let self_checking = std::env::var("L1_DATA_SELF_CHECK").as_deref() == Ok("1");

    let app = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let app = app.menu(macos_menu).on_menu_event(|app, event| {
        if event.id() == CLOSE_WINDOW
            && let Some(window) = app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false))
            && let Err(e) = window.close()
        {
            eprintln!("close window failed: {e}");
        }
    });
    app.plugin(tauri_plugin_dialog::init())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            let engine = tauri::async_runtime::block_on(Engine::open(engine_config(app)?))?;
            app.manage(engine.clone());
            if self_checking {
                tauri::async_runtime::spawn(self_check(app.handle().clone(), engine));
                return Ok(());
            }
            forward_events(app.handle().clone(), engine.subscribe());
            let window = WebviewWindowBuilder::from_config(app.handle(), &app.config().app.windows[0])?
                .theme(window_theme(engine.settings().color_scheme));
            // macOS keeps the native traffic lights over the webview; Windows and Linux draw their own chrome.
            #[cfg(target_os = "macos")]
            let window = window
                .decorations(true)
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(18.0, 28.0));
            let window = window.build()?;
            // The configured background is the dark one; System only resolves once the window exists.
            if matches!(window.theme(), Ok(tauri::Theme::Light))
                && let Err(e) = window.set_background_color(Some(LIGHT_BACKGROUND))
            {
                eprintln!("window background failed: {e}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running L1 Data");
}

#[cfg(test)]
mod tests {
    use super::*;

    const IPC_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/ipc.rs");
    const ENGINE_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../crates/engine/src/lib.rs");

    /// The body of `pub fn <name>(`, by brace count.
    fn sync_fn_body<'a>(source: &'a str, name: &str) -> Option<&'a str> {
        let start = source.find(&format!("pub fn {name}("))?;
        let open = start + source[start..].find('{')?;
        let mut depth = 0usize;
        for (i, c) in source[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(&source[open..open + i]);
                    }
                }
                _ => {}
            }
        }
        None
    }

    /// Tauri runs a sync command inline on the thread that delivered the IPC message, which on
    /// macOS is the main thread, outside its tokio runtime. An engine method such a command calls
    /// must start tasks through `Shared::spawn`, never through a call that needs the runtime on
    /// the current thread.
    #[test]
    fn sync_commands_never_reach_a_bare_tokio_call() {
        const NEEDS_RUNTIME: [&str; 5] = ["tokio::spawn(", "tokio::task::spawn", "spawn_blocking(", "Handle::current(", "block_on("];
        let ipc = std::fs::read_to_string(IPC_PATH).unwrap();
        let engine = std::fs::read_to_string(ENGINE_PATH).unwrap();
        let mut checked = 0;
        for command in ipc.split("#[tauri::command]").skip(1) {
            let Some(signature) = command.lines().find(|l| l.starts_with("pub fn ")) else { continue };
            let body = sync_fn_body(command, signature["pub fn ".len()..].split('(').next().unwrap()).unwrap();
            let method = body.split("engine.").nth(1).map(|rest| rest.split('(').next().unwrap()).unwrap_or_else(|| panic!("no engine call in {signature}"));
            let engine_body = sync_fn_body(&engine, method).unwrap_or_else(|| panic!("Engine::{method} is not a sync method"));
            for pattern in NEEDS_RUNTIME {
                assert!(!engine_body.contains(pattern), "{signature} is sync but Engine::{method} calls {pattern}");
            }
            checked += 1;
        }
        assert_eq!(checked, 10, "the sync commands in ipc.rs");
    }

    #[test]
    fn export_bindings_up_to_date() {
        let fresh_path = std::env::temp_dir().join(format!("l1-data-bindings-{}.ts", std::process::id()));
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

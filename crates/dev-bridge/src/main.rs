mod dispatch;

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Instant;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use engine::{Engine, EngineConfig, MemoryKeyStore};
use futures_util::Stream;
use serde_json::{Map, Value, json};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;
use tower_http::cors::CorsLayer;

use dispatch::{BridgeError, dispatch};

const ADDR: &str = "127.0.0.1:7077";
const VITE_ORIGINS: [&str; 2] = ["http://localhost:5173", "http://127.0.0.1:5173"];

async fn invoke(State(engine): State<Arc<Engine>>, Path(cmd): Path<String>, body: Bytes) -> Response {
    let args = match parse_args(&body) {
        Ok(args) => args,
        Err(message) => return (StatusCode::BAD_REQUEST, Json(json!({ "message": message }))).into_response(),
    };
    let started = Instant::now();
    let result = dispatch(&engine, &cmd, args).await;
    let elapsed = started.elapsed();
    match result {
        Ok(Ok(data)) => {
            eprintln!("invoke {cmd} -> ok ({elapsed:?})");
            Json(json!({ "status": "ok", "data": data })).into_response()
        }
        Ok(Err(error)) => {
            eprintln!("invoke {cmd} -> error {error} ({elapsed:?})");
            Json(json!({ "status": "error", "error": error })).into_response()
        }
        Err(e) => {
            let (status, message) = match e {
                BridgeError::UnknownCommand(c) => (StatusCode::NOT_FOUND, format!("unknown command `{c}`")),
                BridgeError::BadArg { arg, message } => {
                    (StatusCode::BAD_REQUEST, format!("{cmd}: bad argument `{arg}`: {message}"))
                }
                BridgeError::Panicked(m) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{cmd} panicked: {m}")),
            };
            eprintln!("invoke {cmd} -> {status}: {message}");
            (status, Json(json!({ "message": message }))).into_response()
        }
    }
}

/// curl sends form content-type by default, so the body is parsed as JSON whatever the header says.
fn parse_args(body: &[u8]) -> Result<Map<String, Value>, String> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(Map::new());
    }
    match serde_json::from_slice(body) {
        Ok(Value::Object(args)) => Ok(args),
        Ok(_) => Err("args must be a JSON object".into()),
        Err(e) => Err(format!("args are not JSON: {e}")),
    }
}

async fn events(State(engine): State<Arc<Engine>>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = BroadcastStream::new(engine.subscribe()).filter_map(|ev| match ev.map(|ev| Event::default().json_data(ev)) {
        Ok(Ok(frame)) => Some(Ok(frame)),
        Ok(Err(e)) => {
            eprintln!("events: failed to encode AppEvent: {e}");
            None
        }
        Err(lagged) => {
            eprintln!("events: {lagged}");
            None
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

#[tokio::main]
async fn main() {
    let temp_dir = tempfile::tempdir().expect("create temp data dir");
    let data_dir = std::env::var_os("DATABOT_DATA_DIR").map_or_else(|| temp_dir.path().to_owned(), Into::into);
    let engine = Engine::open(EngineConfig {
        data_dir,
        keys: Arc::new(MemoryKeyStore::default()),
    })
    .await
    .expect("open engine");

    let cors = CorsLayer::new()
        .allow_origin(VITE_ORIGINS.map(HeaderValue::from_static))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE]);
    let app = Router::new()
        .route("/invoke/{cmd}", post(invoke))
        .route("/events", get(events))
        .layer(cors)
        .with_state(engine.clone());

    let listener = tokio::net::TcpListener::bind(ADDR).await.expect("bind dev-bridge port");
    eprintln!("dev-bridge on http://{ADDR} (data dir {})", engine.data_dir().display());
    axum::serve(listener, app).await.expect("serve");
}

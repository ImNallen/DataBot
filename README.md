# DataBot

DataBot is a desktop IDE for PostgreSQL, built with Tauri 2, Rust, and React. It has a connection tree, SQL editor tabs, a results grid, an output log, and per-tab transactions. The design is in [docs/architecture.md](docs/architecture.md).

![DataBot running the revenue-by-region query against the seeded shop database](docs/images/databot.png)

## Quickstart

Prerequisites: Rust 1.93 or later, Node 26, pnpm, and Docker.

```sh
pnpm install
pnpm db:up          # Postgres 16 on localhost:5433 with the seeded `shop` database
pnpm tauri dev      # the desktop app; debug builds regenerate src/ipc/bindings.ts
pnpm bridge         # dev-bridge on :7077 plus vite on :5173: the real engine from a browser
```

## Checks

```sh
cargo test --workspace   # engine units, bindings drift test, bridge coverage test
cargo test -p engine --features pg-tests   # engine against the Docker database
pnpm typecheck
pnpm test                # vitest
pnpm build               # production frontend bundle
pnpm self-check          # boots the engine inside the Tauri binary, prints JSON, exits
pnpm bindings            # rewrites src/ipc/bindings.ts after an IPC type or command changes
```

## Layout

- `crates/engine` holds every behavior and every IPC type (`src/model.rs`). It has no Tauri dependency.
- `src-tauri` is the app shell. Each command is a one-line call into the engine.
- `crates/dev-bridge` serves the same engine over HTTP for browser-driven UI work.
- `src` is the React frontend. `src/ipc/bindings.ts` is generated; do not edit it.

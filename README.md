# L1 Data

L1 Data is a desktop IDE for PostgreSQL, built with Tauri 2, Rust, and React. The design is in [docs/architecture.md](docs/architecture.md).

![L1 Data running the revenue-by-region query against the seeded shop database](docs/images/l1-data.png)

## What it does

- The connection tree lists each server's schemas, tables with row counts, views, and functions. Double-click a table to browse its rows in a tab.
- SQL tabs complete table and column names from the live catalog. `⌘↵` runs the statement under the cursor or the selection.
- The results grid streams large results in pages, and **Export** writes them to CSV. The **Output** tab logs notices, command results, and errors.
- Each tab runs in auto-commit or manual-transaction mode on its own session, so `SET` and temp tables stay with the tab.
- `⌘P` searches tables and columns across connections. **Query history** opens a past statement in a new SQL tab.
- The OS credential store holds one master key, and saved passwords are sealed under it. macOS asks for keychain access once per launch.

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
pnpm screenshot          # macOS: rewrites docs/images/l1-data.png from the running app
```

## Layout

- `crates/engine` holds every behavior and every IPC type (`src/model.rs`). It has no Tauri dependency.
- `src-tauri` is the app shell. Each command is a one-line call into the engine.
- `crates/dev-bridge` serves the same engine over HTTP for browser-driven UI work.
- `src` is the React frontend. `src/ipc/bindings.ts` is generated; do not edit it.
- `dev` holds the Docker database, its seed, and the bridge smoke and screenshot scripts.

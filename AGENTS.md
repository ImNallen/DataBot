# AGENTS.md

L1 Data is a desktop IDE for PostgreSQL. A Rust engine does the work, a Tauri 2 shell hosts it, and a React frontend draws it. [README.md](README.md) lists the features and the commands. [docs/architecture.md](docs/architecture.md) explains the design and records each place the code departs from it. Read the "Load-bearing decisions" section of that doc before you change how data moves between Rust and the webview.

## Keep the design rules

Each rule below keeps a class of bug out of the app. Break one only after you change the architecture doc in the same PR.

- `crates/engine` owns all behavior and has no Tauri dependency. Each command in `src-tauri/src/ipc.rs` is a one-line call into `Engine`.
- Every type that crosses IPC lives in `crates/engine/src/model.rs`. `src/ipc/bindings.ts` is generated from it. Do not edit `bindings.ts` by hand.
- Only Rust interprets SQL text. Statement splitting, classification, table-browse SQL, and the `INSERT`, `UPDATE`, and `DELETE` statements for staged edits are built in the engine with its own quoting. The frontend sends the document text and a cursor or selection, never SQL it built.
- Cell values are PostgreSQL's text output, `string | null`. Do not add a per-type decoder. Rendering keys off the column's `TypeCategory`.
- Rust owns result rows. The grid pulls windows with `result_page`, and `state/rowCache.ts` caches them. Do not send whole results to the webview.
- Offsets that cross IPC are UTF-16 code units, which is CodeMirror's unit. The engine converts them once, at the boundary, in `text.rs`.
- The backend emits whole `ConsoleState` and `ConnectionState` snapshots with a rising `rev`. `state/live.ts` keeps the higher `rev` and nothing else writes to it. Only the output log uses deltas.
- A run moves the tab's session into the run task. Commit, rollback, or a second run during a run returns `Busy`. Keep that shape so concurrent use of one session stays impossible.

## Add or change an IPC command

1. Add or change the types in `crates/engine/src/model.rs`. Follow the wire casing in the architecture doc's "Implementation reconciliation" section. Struct fields are camelCase, and enum tags keep the Rust variant name.
2. Implement the behavior as an `Engine` method in `crates/engine`.
3. Add a one-line `#[tauri::command]` in `src-tauri/src/ipc.rs` and register it in `collect_commands!` in `src-tauri/src/main.rs`.
4. Add the same command to the dispatch table in `crates/dev-bridge/src/dispatch.rs`.
5. Run `pnpm bindings` to rewrite `src/ipc/bindings.ts`, and commit that file.
6. Run `cargo test --workspace`. The bindings drift test fails if `bindings.ts` is stale. The bridge coverage test fails if the bridge and the Tauri registration list different commands or argument names.

The app saves `Workspace` and `Settings` as JSON in SQLite, so a type that is saved must still load data written by an older build. To add a field to such a type, give it a fallback in a hand-written `Deserialize`, as `Layout` does in `model.rs`. Do not use `#[serde(default)]` on the struct, because specta then marks every field optional in `bindings.ts`.

## Run the checks

Run the checks that cover your change before you open a PR. Docker is needed only for the database-backed checks.

| Command | Covers | Needs |
|---|---|---|
| `cargo test --workspace` | engine units, bindings drift, bridge coverage | nothing |
| `cargo test -p engine --features pg-tests` | engine against a real server | `pnpm db:up` |
| `pnpm typecheck` | the frontend types | nothing |
| `pnpm test` | vitest units for state, formatting, and shell | nothing |
| `pnpm build` | the production bundle | nothing |
| `pnpm self-check` | the engine booted inside the Tauri binary | `pnpm db:up` |
| `dev/bridge-smoke.sh` | the dev-bridge over HTTP, end to end | `pnpm db:up` and `cargo build -p dev-bridge` first. The script starts its own bridge. |

`pnpm db:up` starts Postgres 16 on `localhost:5433` with the seeded `shop` database from `dev/seed.sql`. The `lab.type_zoo` table in the seed holds one column per awkward type, for value-rendering tests.

## Prove UI changes in the running app

A passing typecheck does not show that a UI change works. Drive the real UI against the real engine:

1. Run `pnpm db:up`, then `pnpm bridge`. The bridge serves the engine on `:7077` and vite serves the UI on `:5173`.
2. Open `http://localhost:5173` in a browser tool such as agent-browser or Playwright. `src/dev/bridgeShim.ts` forwards every IPC call to the bridge, so the generated bindings run unchanged.
3. Select elements by `data-testid`. Add a `data-testid` to any new control you need to reach.
4. Connect to `postgres://l1data:l1data@localhost:5433/shop` and exercise the change.

The bridge has two limits. It runs in Chromium, not WKWebView, and it has no native dialogs, so **Export** fails there. For window chrome, file dialogs, or anything WebKit-specific, run `pnpm tauri dev` and check the real window. On macOS, `pnpm screenshot` rewrites `docs/images/l1-data.png` from the running app.

The environment variables that change the data directory, the credential store, and the test databases are listed in the README.

## Keep the docs true

- When you add or change a user-visible feature or shortcut, update the "What it does" list in `README.md`.
- When the code departs from `docs/architecture.md`, change the section that is now wrong, or add a bullet to "Implementation reconciliation". Change the doc in the same PR as the code.
- When a change alters the main window, regenerate the screenshot with `pnpm screenshot`.

## Write commits and PRs

- Title commits and PRs in Conventional Commits form, `type(scope): subject`, with an imperative subject. Types in use are `feat`, `docs`, and `chore`. Scopes in use are `app`, `engine`, `ui`, `window`, `icons`, `scaffold`, `readme`, and `architecture`.
- Open one PR per change against `main`. PRs merge as one squash commit.
- Write the PR body as a short briefing in these sections: `## Why`, `## Scope`, `## Tradeoffs`, `## Blast Radius`, and `## Verification`. Drop a section that has nothing to say. Under `## Verification`, name each check you ran and its result, say what you did not test, and attach a screenshot for UI changes.
- After you open a PR, watch it if your harness has a PR watcher, such as `watch_pull_request` in T3 Code. Fix failing checks and answer review comments without waiting to be asked. If your harness has no watcher, skip this step.

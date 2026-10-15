<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/l1-logo-white.svg">
  <img src="docs/images/l1-logo-black.svg" alt="L1 Data logo" width="64">
</picture>

# L1 Data

L1 Data is a desktop IDE for PostgreSQL, built with Tauri 2, Rust, and React. The design is in [docs/architecture.md](docs/architecture.md). Agents working in this repo start with [AGENTS.md](AGENTS.md).

![L1 Data running the revenue-by-region query against the seeded shop database](docs/images/l1-data.png)

## What it does

### Connections and the catalog

- The connection tree shows each connection's database, schemas, tables, views, and functions. Tables show the planner's row estimate. Expand a table to see its columns, types, and primary key.
- Double-click a table or a view to browse its rows in a tab. Double-click a function to insert a call into the active SQL tab.
- `⌘P` searches tables, views, functions, and columns in every connected catalog. A column opens its table.
- The connection dialog tests a connection and shows the server version before you save. The **…** menu on a connection connects, disconnects, opens a SQL tab, refreshes the catalog, edits, and deletes.
- The OS credential store holds one master key, and saved passwords are sealed under it. macOS asks for keychain access once per launch.

### SQL tabs

- SQL tabs complete table and column names from the live catalog. `⌘↵` or **Run** runs the statement under the cursor or the selection. `Esc` or **Cancel** stops a running query.
- Each SQL tab has its own session, so `SET` and temp tables stay with the tab. The status-bar chip switches the tab between auto-commit and manual-transaction mode.
- In manual mode, **Commit** and **Rollback** appear while a transaction is open, and the tab shows a dot. Closing that tab or disconnecting asks before it rolls back.
- An error shows its detail, hint, and SQLSTATE, and the editor underlines the error position.
- The **Output** button in the results header opens a timestamped log of everything the tab ran: each statement, its server messages such as `RAISE NOTICE` and warnings, and its result line. **Commit**, **Rollback**, and table edits are logged too. When a statement returns no rows, the log fills the results pane. The button turns amber when the latest run raised a warning.
- **Query history** searches past statements and opens one in a new SQL tab.

### Results and table data

- The results grid streams large results in pages. Select cells and press `⌘C` to copy them as TSV. Press `Enter`, or click the **…** on a cut-off value, to see the full value.
- A run with several result sets has a selector to switch between them.
- **Export** writes the result to CSV, up to the row limit.
- A table tab pages through rows, from 10 to 1,000 per page. It filters with a `WHERE` condition or per-column filters, and sorts with `ORDER BY`. Click a header to sort by it, and Shift-click to add a column to the sort.
- A table tab with a primary key can add, edit, and delete rows, and set a cell to `NULL` or `DEFAULT`. Changes stay pending until **Submit** (`⌘S`), which applies them all in one transaction or none of them. **Revert** drops them.

### The window

- **Settings** (`⌘,`) opens in place of the sidebar and editor. **Appearance** picks a System, Light, or Dark scheme and the themes for each. It also sets the density (Compact, Standard, or Spacious), the speed of panel, dialog, and menu animations, and the interface and monospace fonts and sizes. The monospace font is used by the SQL editor and the result tables. **Queries** sets the row limit, the table page size, and whether a script stops at its first error.
- On macOS the window keeps the native traffic lights. On Windows and Linux the app draws its own window controls and resize edges.
- The right panel holds a placeholder for an AI assistant.

## Keyboard shortcuts

`Ctrl` works in place of `⌘` on Windows and Linux.

| Keys | Action |
|---|---|
| `⌘T` | New SQL tab |
| `⌘N` | New connection |
| `⌘P` | Search the catalog, or search settings while Settings is open |
| `⌘,` | Open or close Settings |
| `⌘W` | Close the tab, or close Settings |
| `⌘↵` | Run the statement under the cursor or the selection |
| `Esc` | Cancel the running query |
| `Enter` | Edit the selected cell in an editable table, or show its full value elsewhere |
| `F2` | Edit the selected cell |
| `⌘S` | Submit pending table edits |
| `⌘⌫` | Delete or restore the selected rows |
| `⌘C` | Copy the selected cells as TSV |
| `⌘A` | Select all cells |

On macOS, **Close Window** moves to `⇧⌘W` so that `⌘W` closes a tab.

## Quickstart

The repo is tested with Rust 1.93, Node 26, and pnpm 11. You also need Docker.

```sh
pnpm install
pnpm db:up          # Postgres 16 on localhost:5433 with the seeded `shop` database
pnpm tauri dev      # the desktop app
pnpm bridge         # dev-bridge on :7077 plus vite on :5173: the real engine from a browser
```

Connect to `postgres://l1data:l1data@localhost:5433/shop`. The seed also creates `lab.type_zoo`, a table with one column for each hard-to-render type.

## Checks

```sh
cargo test --workspace   # engine units, bindings drift test, bridge coverage test
cargo test -p engine --features pg-tests   # engine against the Docker database
pnpm typecheck
pnpm test                # vitest
pnpm build               # production frontend bundle
pnpm self-check          # boots the engine inside the Tauri binary, connects to the Docker database, prints JSON, exits
cargo build -p dev-bridge && dev/bridge-smoke.sh   # drives the bridge over HTTP against the Docker database
pnpm bindings            # rewrites src/ipc/bindings.ts after an IPC type or command changes
pnpm icons               # rewrites src-tauri/icons from src-tauri/app-icon.svg
pnpm screenshot          # macOS: rewrites docs/images/l1-data.png from the running app
```

A debug binary rewrites `src/ipc/bindings.ts` each time it starts, so `pnpm tauri dev` and `pnpm self-check` keep it current too.

`pnpm screenshot` starts its own Postgres container on port 5434. It needs `swift`, `osascript`, and `python3`, free ports 7077, 5173, and 5434, and Accessibility and Screen Recording permission for the terminal.

## Environment variables

| Variable | Effect |
|---|---|
| `L1_DATA_DATA_DIR` | The data directory. The app reads it only in debug builds. The dev-bridge uses a temporary directory without it. |
| `L1_DATA_SECRET_STORE=memory` | Keeps the master key in memory instead of the OS credential store. Debug builds only. |
| `L1_DATA_SELF_CHECK=1` | Runs the self-check and exits without opening a window. |
| `L1_DATA_SELF_CHECK_URL` | The database for the self-check. Default `postgres://l1data:l1data@localhost:5433/shop`. |
| `L1_DATA_TEST_PG` | The database for `pg-tests`. Same default. |
| `UPDATE_BINDINGS=1` | Makes the bindings drift test rewrite `src/ipc/bindings.ts` instead of failing. |

## Layout

- `crates/engine` holds every behavior and every IPC type (`src/model.rs`). It has no Tauri dependency.
- `src-tauri` is the app shell. Each command is a one-line call into the engine.
- `crates/dev-bridge` serves the same engine over HTTP for browser-driven UI work.
- `src` is the React frontend. `src/ipc/bindings.ts` is generated, so do not edit it.
- `dev` holds the Docker database, its seed, and the bridge smoke, screenshot, and icon scripts.
- `docs` holds the architecture doc and the README images.

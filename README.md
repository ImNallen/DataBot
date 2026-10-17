<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/l1-logo-white.svg">
  <img src="docs/images/l1-logo-black.svg" alt="L1 Data logo" width="64">
</picture>

# L1 Data

L1 Data is a desktop IDE for PostgreSQL, built with Tauri 2, Rust, and React. The design is in [docs/architecture.md](docs/architecture.md). Agents working in this repo start with [AGENTS.md](AGENTS.md).

![L1 Data running the revenue-by-region query against the seeded shop database, with the assistant answering a question about it](docs/images/l1-data.png)

## What it does

### Connections and the catalog

- The connection tree shows each connection's databases, their schemas with their table counts, the tables and views of each schema, and a Functions group. Expand a table to see Columns, with a type glyph, primary and foreign key marks, the type, and `· null` on nullable columns. Defaults, Keys (primary, foreign with its target, unique, and check), Indexes (key list, method, and partial predicate), and Triggers (timing, events, and function) follow when the table has any.
- A connection row's `shown/total` count opens a picker of the server's databases, and a database row's count opens a picker of its schemas. Check a box to show that database or schema in the tree, or use **All**, **Default only**, or **None**. Adding a database also shows its default schema. System databases and schemas stay out of the pickers until you turn on **Show system databases** or **Show system schemas**. The count turns amber when nothing is shown. Each connection keeps its choices. The picker opens with its filter focused, `Tab` cycles inside it, and `Esc` or **Done** closes it and returns focus to the count.
- A disconnected connection row shows a **Connect** button in place of its count; a connected row shows only the count, dimmed while it is off.
- Double-click a table or a view to browse its rows in a tab. Double-click a function to insert a call into the active tab.
- The sidebar's search box filters the tree in place. The tree keeps the tables, views, columns, and functions whose names contain every word you type, in the schemas it shows, and opens each match's parents and highlights the match. A matching column sits under its table. `Enter` opens the first table or view whose name starts with the words you typed, else the first one listed. `Esc` clears the search. `⌘P` focuses the box.
- The connection dialog lists the saved connections on the left, with a live dot on each connected one. Click one to edit it, or **New** to add another. Paste a `postgres://` URL to fill in the server, database, user, password, and SSL mode. The name is optional and defaults to the host and database. Pick a color to mark the connection in the tree and the top bar. To shade each colored connection in the tree with its color instead of a dot, turn on **Tint connections by color** in **Settings** > **Appearance**. **Test** shows the server version before you save. Leaving a form with unsaved edits, by choosing another connection or closing the dialog, asks before it drops them. Right-clicking a connection connects, disconnects, opens a SQL tab, refreshes the catalog, edits, and deletes.
- The OS credential store holds one master key, and saved passwords are sealed under it. macOS asks for keychain access once per launch.

### Query tabs

- Every tab is a query editor. A tab opened from a table also browses that table. Tabs complete table and column names from the live catalog. The editor tints the text of the statement `⌘↵` will run. A statement ends at `;`, or at a blank line when the next line starts a new statement. `⌘↵` or **Run** runs the selection as written, or the marked statement when nothing is selected. When a tab holds several statements, `⌘⇧↵` opens a list of them and an **All** row, and highlights in the editor what the row under the pointer or the arrow keys would run. `Enter`, a click, or a statement's number runs it. `Esc` closes the list. `Esc` or **Cancel** stops a running query.
- Each tab has its own session, so `SET` and temp tables stay with the tab. The connection name in the top bar picks the tab's connection. The **Auto-commit** menu switches the tab between auto-commit and manual-transaction mode. It also shows when a lost connection rolled back the open transaction. Double-click a tab to rename it.
- In manual mode, **Commit** and **Rollback** appear while a transaction is open, and the tab shows a dot. Closing that tab or disconnecting asks before it rolls back.
- An error shows its detail, hint, and SQLSTATE, and the editor underlines the error position.
- The **Output** button at the right end of the results header opens a timestamped log of everything the tab ran: each statement, its server messages such as `RAISE NOTICE` and warnings, and its result line. **Commit**, **Rollback**, and table edits are logged too. When a statement returns no rows, the log fills the results pane. The button turns amber when the latest run raised a warning.
- **Query history** groups identical SQL per connection and database. Search SQL, connection names, databases, or errors, then filter by **All**, **Failed**, or **Writes**. Select a query to preview its SQL and paged run timeline. Copy it, open or run it in a new tab on its saved database, or insert it into the active tab.

### Results and table data

- The results grid streams large results in pages. Select cells and press `⌘C` to copy them as TSV. Press `Enter`, or click the **…** on a cut-off value, to see the full value.
- A run with several result sets has a selector to switch between them.
- **Export** writes the result to CSV, up to the row limit.
- A table tab pages through rows, from 10 to 1,000 per page. It filters with a `WHERE` condition or per-column filters, and sorts with `ORDER BY`. Click a header to sort by it, and Shift-click to add a column to the sort.
- A table tab with a primary key can add, edit, and delete rows, and set a cell to `NULL` or `DEFAULT`. Changes stay pending until **Submit** (`⌘S`), which applies them all in one transaction or none of them. In manual mode, submitted changes wait in the tab's open transaction until **Commit**. **Revert** drops them.

### The assistant

- The right panel is a chat with Claude. It runs on your own Claude subscription through the `claude` CLI you have installed and signed in to, so L1 Data needs no API key. Each message sends Claude the active tab's connection, database, and SQL, the statement at the cursor or the selection, the last error, and an outline of the schemas the sidebar shows.
- Claude reads the catalog through two tools that never ask. One describes tables, and the other searches table, column, and function names. It can also run a read-only query. The permission picker under the message box chooses when a query asks first, and a change applies from the next query. In **Ask first**, every query waits for **Run** or **Deny**. In **Auto**, a query runs without asking only when it is a read whose every function call and operator is a vetted built-in: aggregates, window functions, math, string, date and time, JSON, array, and catalog helpers such as `pg_size_pretty`, and the comparison, arithmetic, text, pattern, JSON, and array operators. A query that calls any other function or operator, uses a `U&` escape, or selects `INTO` asks first and names what it found. Views, functions, and casts to or from types defined in the database are not inspected, so your database role is the last limit on what a query can reach. Only `SELECT`, `WITH`, `VALUES`, `TABLE`, `SHOW`, and `EXPLAIN` run. Each query runs on its own session in a `READ ONLY` transaction with a 30-second timeout, and Claude sees at most 50 rows.
- SQL in a reply shows as a card that names the tables it uses. **Run in new tab** opens the SQL in a new tab and runs it. **Insert at cursor** inserts it into the active tab. **Replace tab** replaces the active tab's text as one edit that `⌘Z` undoes. A card whose SQL writes, or calls a function the app cannot vouch for, offers **Open in new tab** in place of **Run in new tab**, so it waits for you to run it.
- The paperclip attaches the result the active tab shows, up to 100 rows. Suggestion chips under a reply send their text as the next message. `Enter` sends, `Shift+Enter` starts a new line, and **Stop** ends the turn: it denies a waiting approval, asks the CLI to stop, and kills the process if it has not exited after 5 seconds. Quitting the app stops every turn the same way with a 1-second grace and kills any `claude` still running within about 4 seconds.
- The model and effort pickers list the models and effort levels your CLI offers. Switching models keeps the effort when the new model offers it. A new chat starts in **Ask first**, on the model and effort of your newest chat while the CLI still offers them. Chats are saved. A restart reopens the chat you had open, the history button lists the others, and the next message continues where the conversation left off. The history button shows a dot while a chat waits for your approval. If the CLI no longer has a chat's session, the next message restarts it with a summary of the conversation and says so. Deleting a chat asks first and removes it from L1 Data. The CLI keeps its own transcript of the conversation under its config directory, at `projects/<the app's assistant directory, with slashes as dashes>/<session id>.jsonl`.
- **Settings** > **Providers** shows the CLI's version, sign-in state, and plan, with a switch that turns the provider on or off. It also sets the display name, the binary path, the config directory, and the launch arguments. Launch arguments pass to the CLI, except the flags the app sets itself, which the field lists as ignored. `--model` and `--effort` there set the model and effort a new chat starts with. **Health check interval** under **Advanced** sets how often the app checks the CLI in the background. The default is 300 seconds, and 0 turns the check off.
- **Settings** > **Usage**, also opened by the chart button at the bottom of the sidebar, shows how much of each Claude and Codex subscription limit is left. Each window, such as the five-hour session or the week, gets a card with the percent left, a **Running low** warning, and the time until it resets. The app asks your own `claude` and `codex` CLIs for these numbers and reads no credentials itself. The refresh button at the top right reads them again, and the page also reads them again when a window resets while it is open. A CLI that is not installed shows as **not installed**, and a signed-out one shows the command that signs it in.

### The window

- **Settings** (`⌘,`) opens in place of the sidebar and editor. **Appearance** picks a System, Light, or Dark scheme and the themes for each. It also sets the density (Compact, Standard, or Spacious), the speed of panel, dialog, and menu animations, and the interface and monospace fonts and sizes. The monospace font is used by the SQL editor and the result tables. **Queries** sets the row limit, the table page size, and whether a script stops at its first error. The search box above the sections filters the settings in place and shows the matches with their controls. `Esc` clears it and returns to the section you were on.
- On macOS the window keeps the native traffic lights. On Windows and Linux the app draws its own window controls and resize edges.

## Keyboard shortcuts

`Ctrl` works in place of `⌘` on Windows and Linux.

| Keys | Action |
|---|---|
| `⌘T` | New SQL tab |
| `⌘N` | New connection |
| `⌘P` | Focus the sidebar search: the tree, or the settings while Settings is open |
| `⌘,` | Open or close Settings |
| `⌘W` | Close the tab, or close Settings |
| `⌘↵` | Run the selection, or the marked statement under the cursor |
| `⌘⇧↵` | Choose which statement to run, or all of them |
| `Esc` | Cancel the running query |
| `Enter` | Edit the selected cell in an editable table, or show its full value elsewhere |
| `F2` | Edit the selected cell |
| `⌘S` | Submit pending table edits |
| `⌘⌫` | Delete or restore the selected rows |
| `⌘C` | Copy the selected cells as TSV |
| `⌘A` | Select all cells |

In query history, `↑` and `↓` select a query, `Enter` opens it in a new tab, `⌘↵` runs it in a new tab, and `Alt+Enter` inserts it at the active tab's cursor. `⌘C` copies the query unless text is selected in the search field. `Esc` closes history. **Clear history** asks for confirmation.

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
cargo test -p engine --features claude-smoke --test claude_smoke -- --nocapture   # the assistant through your installed claude CLI
pnpm bindings            # rewrites src/ipc/bindings.ts after an IPC type or command changes
pnpm icons               # rewrites src-tauri/icons from src-tauri/app-icon.svg
pnpm screenshot          # macOS: rewrites docs/images/l1-data.png from the running app
```

A debug binary rewrites `src/ipc/bindings.ts` each time it starts, so `pnpm tauri dev` and `pnpm self-check` keep it current too.

The `claude-smoke` test needs the `claude` CLI installed and signed in, and the Docker database. It spends three Haiku turns on your Claude subscription, and one of them waits 75 seconds for an approval.

`pnpm screenshot` starts its own Postgres container on port 5434. It needs `swift`, `osascript`, `cliclick`, and `python3`, free ports 7077, 5173, and 5434, and Accessibility and Screen Recording permission for the terminal.

## Environment variables

| Variable | Effect |
|---|---|
| `L1_DATA_DATA_DIR` | The data directory. The app reads it only in debug builds. The dev-bridge uses a temporary directory without it. |
| `L1_DATA_SECRET_STORE=memory` | Keeps the master key in memory instead of the OS credential store. Debug builds only. |
| `L1_DATA_SELF_CHECK=1` | Runs the self-check and exits without opening a window. |
| `L1_DATA_SELF_CHECK_URL` | The database for the self-check. Default `postgres://l1data:l1data@localhost:5433/shop`. |
| `L1_DATA_TEST_PG` | The database for `pg-tests` and `claude-smoke`. Same default. |
| `UPDATE_BINDINGS=1` | Makes the bindings drift test rewrite `src/ipc/bindings.ts` instead of failing. |

## Layout

- `crates/engine` holds every behavior and every IPC type (`src/model.rs`). It has no Tauri dependency.
- `src-tauri` is the app shell. Each command is a one-line call into the engine.
- `crates/dev-bridge` serves the same engine over HTTP for browser-driven UI work.
- `src` is the React frontend. `src/ipc/bindings.ts` is generated, so do not edit it.
- `dev` holds the Docker database, its seed, and the bridge smoke, screenshot, and icon scripts.
- `docs` holds the architecture doc and the README images.

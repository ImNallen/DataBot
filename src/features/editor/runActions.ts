import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  commands,
  type ConsoleConfig,
  type DatabaseRef,
  type RunRequest,
  type RunTarget,
  type Settings,
  type TabId,
  type TableQuery,
  type TxnMode,
} from "../../ipc/bindings";
import { applyErrorText, configureErrorText, disconnectErrorText, runErrorText, txnErrorText } from "../../ipc/errors";
import { findRelation, useCatalog, viewFor } from "../../state/catalog";
import { homeDb, sameDb } from "../../state/dbKey";
import { useLive } from "../../state/live";
import { dropRowCaches } from "../../state/rowCache";
import { isRunning } from "../../state/status";
import { pendingCount, toChanges, useTableEdits, type TableEdits } from "../../state/tableEdits";
import { EMPTY_QUERY, isTableTab, nextUntitled, tabTarget, useWorkspace, type ConsoleTarget, type RelationRef, type Tab, type TableTab } from "../../state/workspace";
import {
  cursorAnchor,
  cursorOf,
  dropEditor,
  editorStateOf,
  flashRanges,
  installEditorBehavior,
  seedEditor,
  showDiagnostics,
  showRunTarget,
  textOf,
} from "./editorStates";
import { openChooser } from "./chooserState";
import { sqlIdent } from "./sqlIdent";

const ws = () => useWorkspace.getState();
const notify = (text: string) => ws().notify(text);

function consoleConfig({ db, mode }: ConsoleTarget): ConsoleConfig | null {
  return db && { connectionId: db.connectionId, database: db.database, schema: null, mode };
}

function sameConfig(a: ConsoleConfig, b: ConsoleConfig): boolean {
  return a.connectionId === b.connectionId && a.database === b.database && a.schema === b.schema && a.mode === b.mode;
}

async function ensureConsole(tab: Tab): Promise<boolean> {
  const config = consoleConfig(tab.console);
  if (!config) {
    notify("Choose a connection for this tab.");
    return false;
  }
  const live = useLive.getState().consoles[tab.id];
  if (live && sameConfig(live.config, config)) return true;
  const res = await commands.consoleConfigure(tab.id, config);
  if (res.status === "error") {
    notify(configureErrorText(res.error));
    return false;
  }
  return true;
}

const sent = new Map<TabId, { runId: number; text: string }>();

export function browseQuery(schema: string, table: string): string {
  return `SELECT * FROM ${sqlIdent(schema)}.${sqlIdent(table)}`;
}

export function isBrowsing(tab: Tab): tab is TableTab {
  return isTableTab(tab) && textOf(tab.id).trim().replace(/;$/, "") === browseQuery(tab.table.schema, tab.table.table);
}

type PageTarget = { page: number; exactRowCount?: number };

// A page change is saved on the tab only once the engine accepts the run. One that arrives mid-run waits for that
// run to finish, and the latest one wins. It runs only as a page load, never as the editor's script.
const queuedPages = new Map<TabId, PageTarget>();

async function runTab(tabId: TabId, target?: PageTarget, script?: RunTarget): Promise<void> {
  const tab = ws().tabs[tabId];
  if (!tab) return;
  if (target && !isBrowsing(tab)) return;
  if (isRunning(useLive.getState().consoles[tabId])) {
    if (target) queuedPages.set(tabId, target);
    return;
  }
  if (!(await ensureConsole(tab))) return;

  let request: RunRequest;
  let text = "";
  if (isBrowsing(tab)) {
    const { schema, table, page, query } = tab.table;
    request = { kind: "tablePage", schema, table, page: target?.page ?? page, query };
  } else {
    const state = editorStateOf(tabId);
    const sel = state.selection.main;
    text = state.doc.toString();
    request = {
      kind: "script",
      text,
      target: script ?? (sel.empty ? { kind: "cursor", offset: sel.head } : { kind: "selection", from: sel.from, to: sel.to }),
    };
    showDiagnostics(tabId, []);
  }

  const res = await commands.consoleRun(tabId, request);
  if (res.status === "error") {
    notify(runErrorText(res.error));
    return;
  }
  showResults();
  if (target && request.kind === "tablePage") ws().setTablePage(tabId, target.page, target.exactRowCount);
  if (request.kind === "script") {
    sent.set(tabId, { runId: res.data.runId, text });
    flashRanges(tabId, res.data.statements);
    showRunErrors(useLive.getState());
  }
}

/** Runs the selection or the statement at the cursor, or `script` when given. A browsing table tab loads its page. */
export function runActive(script?: RunTarget): void {
  const id = ws().active;
  if (id) void runTab(id, undefined, script);
}

/** Asks which statement to run when the script holds several and nothing is selected; otherwise runs like `runActive`. */
export async function chooseAndRun(): Promise<void> {
  const id = ws().active;
  const tab = id ? ws().tabs[id] : undefined;
  if (!id || !tab) return;
  const state = editorStateOf(id);
  const sel = state.selection.main;
  if (isBrowsing(tab) || !sel.empty) return runActive();
  if (isRunning(useLive.getState().consoles[id]) || !(await ensureConsole(tab))) return;
  const text = state.doc.toString();
  const outline = await commands.scriptOutline(text, sel.head);
  if (ws().active !== id || editorStateOf(id).doc !== state.doc) return;
  if (outline.statements.length < 2) return runTab(id, undefined, { kind: "cursor", offset: sel.head });
  const anchor = cursorAnchor();
  if (!anchor) return;
  openChooser({ tabId: id, text, statements: outline.statements, active: { kind: "statement", index: outline.atCursor ?? 0 }, anchor });
}

export function cancelActive(): boolean {
  const id = ws().active;
  if (!id || !isRunning(useLive.getState().consoles[id])) return false;
  void commands.consoleCancel(id);
  return true;
}

export async function endTransaction(tabId: TabId, verb: "commit" | "rollback"): Promise<void> {
  const res = verb === "commit" ? await commands.consoleCommit(tabId) : await commands.consoleRollback(tabId);
  if (res.status === "error") notify(txnErrorText(res.error));
}

async function reconfigure(tabId: TabId, patch: Partial<ConsoleTarget>) {
  const tab = ws().tabs[tabId];
  if (!tab) return;
  const config = consoleConfig({ ...tab.console, ...patch });
  if (config && useLive.getState().consoles[tabId]) {
    const res = await commands.consoleConfigure(tabId, config);
    if (res.status === "error") {
      notify(configureErrorText(res.error));
      return;
    }
  }
  ws().patchConsole(tabId, patch);
}

export const setTabMode = (tabId: TabId, mode: TxnMode) => reconfigure(tabId, { mode });

export function setTabTarget(tabId: TabId, db: DatabaseRef): Promise<void> {
  const edits = useTableEdits.getState().byTab[tabId];
  // Staged edits name a table, not a database, so submitting them after a switch would write to another database.
  if (edits && pendingCount(edits) > 0) {
    notify("Submit or revert the pending changes first.");
    return Promise.resolve();
  }
  return reconfigure(tabId, { db });
}

function defaultTarget(): DatabaseRef | null {
  const s = ws();
  const active = s.active ? s.tabs[s.active] : undefined;
  if (active) return tabTarget(active);
  const live = useLive.getState().connections;
  const configs = Object.values(s.configs);
  const config = configs.find((c) => live[c.id]?.status.kind === "Connected") ?? configs[0];
  return config ? homeDb(config) : null;
}

export function openSqlTab(opts: { db?: DatabaseRef | null; text?: string; title?: string } = {}): TabId {
  const id = crypto.randomUUID();
  seedEditor(id, opts.text ?? "");
  ws().addTab({
    id,
    title: opts.title ?? nextUntitled(Object.values(ws().tabs)),
    console: { db: opts.db ?? defaultTarget(), mode: "AutoCommit" },
    table: null,
  });
  return id;
}

function showResults() {
  if (!ws().layout.results) ws().setLayout({ results: true });
}

export function openTableTab(ref: RelationRef): void {
  const existing = Object.values(ws().tabs).find(
    (t) => isTableTab(t) && sameDb(t.console.db, ref.db) && t.table.schema === ref.schema && t.table.table === ref.relation,
  );
  ws().select(ref);
  showResults();
  if (existing) {
    ws().setActive(existing.id);
    return;
  }
  const id = crypto.randomUUID();
  seedEditor(id, browseQuery(ref.schema, ref.relation));
  ws().addTab({
    id,
    title: ref.relation,
    console: { db: ref.db, mode: "AutoCommit" },
    table: { schema: ref.schema, table: ref.relation, page: 0, query: EMPTY_QUERY },
  });
}

const loadedTables = new Set<TabId>();

// Loads only as a page, so a restored tab whose saved text is no longer the browse query never runs that text unasked.
export function loadTableOnce(tabId: TabId): void {
  const tab = ws().tabs[tabId];
  if (loadedTables.has(tabId) || !isTableTab(tab)) return;
  loadedTables.add(tabId);
  if (useLive.getState().consoles[tabId]?.run.kind !== "Finished") void runTab(tabId, { page: tab.table.page });
}

// The store updates before the IPC so a second change made meanwhile builds on this one.
// Writes run one at a time, each sending the settings as they are when it runs, so the last write holds every change.
let settingsWrites: Promise<unknown> = Promise.resolve();

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const prev = ws().settings;
  const next = { ...prev, ...patch };
  ws().setSettings(next);
  const write = settingsWrites.then(() => commands.settingsSet(ws().settings));
  settingsWrites = write.catch(() => {});
  await write;
  if (next.tablePageSize === prev.tablePageSize) return;
  for (const tab of Object.values(ws().tabs)) if (isTableTab(tab)) setTablePage(tab.id, 0);
}

export async function lastTablePage(tabId: TabId): Promise<void> {
  const tab = ws().tabs[tabId];
  if (!isTableTab(tab)) return;
  const { schema, table, query } = tab.table;
  const res = await commands.exactRowCount(tab.console.db, schema, table, query);
  if (res.status === "error") {
    notify(res.error.kind === "NotConnected" ? "Connect to jump to the last page." : res.error.message);
    return;
  }
  setTablePage(tabId, Math.max(0, Math.ceil(res.data / ws().settings.tablePageSize) - 1), res.data);
}

export function setTablePage(tabId: TabId, page: number, exactRowCount?: number): void {
  void runTab(tabId, { page, exactRowCount });
}

export function updateTableQuery(tabId: TabId, update: (q: TableQuery) => TableQuery): void {
  const tab = ws().tabs[tabId];
  if (!isTableTab(tab)) return;
  ws().setTableQuery(tabId, update(tab.table.query));
  void runTab(tabId, { page: 0 });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function tablePrimaryKey(tab: TableTab): string[] {
  const rel = findRelation(viewFor(useCatalog.getState().views, tab.console.db), tab.table.schema, tab.table.table);
  return rel?.kind === "Table" ? rel.columns.filter((c) => c.pk).map((c) => c.name) : [];
}

export async function submitEdits(tabId: TabId): Promise<void> {
  const tab = ws().tabs[tabId];
  const edits = useTableEdits.getState().byTab[tabId];
  if (!isTableTab(tab) || !edits || pendingCount(edits) === 0) return;
  const store = useTableEdits.getState();
  if (!store.beginSubmit(tabId)) return;
  try {
    await applyEdits(tab, edits);
  } finally {
    store.endSubmit(tabId);
  }
}

async function applyEdits(tab: TableTab, edits: TableEdits): Promise<void> {
  const tabId = tab.id;
  if (!(await ensureConsole(tab))) return;
  const count = pendingCount(edits);
  const { changes, rowOf } = toChanges(edits, tab.table.schema, tab.table.table, tablePrimaryKey(tab));
  const res = await commands.tableApply(tabId, changes);
  if (res.status === "error") {
    const failedAt = "change" in res.error ? rowOf(res.error.change) : null;
    useTableEdits.setState((s) => ({ byTab: { ...s.byTab, [tabId]: { ...edits, failedAt } } }));
    notify(applyErrorText(res.error));
    return;
  }
  useTableEdits.getState().clear(tabId);
  notify(res.data.committed ? `Saved ${plural(count, "change")}.` : `${plural(count, "change")} wait in the open transaction. Commit to keep them.`);
  void runTab(tabId, { page: tab.table.page });
}

function forgetTab(tabId: TabId) {
  sent.delete(tabId);
  queuedPages.delete(tabId);
  loadedTables.delete(tabId);
  dropRowCaches(tabId);
  dropEditor(tabId);
  useTableEdits.getState().clear(tabId);
  ws().closeTab(tabId);
}

export async function closeTab(tabId: TabId, discardEdits = false): Promise<void> {
  const edits = useTableEdits.getState().byTab[tabId];
  if (!discardEdits && edits && pendingCount(edits) > 0) {
    ws().open({
      kind: "confirm",
      title: "Close tab with unsaved changes?",
      body: `Closing discards ${plural(pendingCount(edits), "change")} that haven't been submitted.`,
      confirmLabel: "Discard and close",
      onConfirm: () => void closeTab(tabId, true),
    });
    return;
  }
  if (!useLive.getState().consoles[tabId]) return forgetTab(tabId);
  const res = await commands.consoleClose(tabId, false);
  if (res.status === "ok") return forgetTab(tabId);
  if (res.error.kind !== "OpenTransactions") {
    notify(disconnectErrorText(res.error));
    return;
  }
  ws().open({
    kind: "confirm",
    title: "Close tab with an open transaction?",
    body: "Closing rolls back the uncommitted work in this tab.",
    confirmLabel: "Roll back and close",
    onConfirm: () => void commands.consoleClose(tabId, true).then(() => forgetTab(tabId)),
  });
}

// The Finished event can arrive before or after consoleRun returns, so both paths call this.
function showRunErrors(s: ReturnType<typeof useLive.getState>) {
  for (const [tabId, req] of sent) {
    const run = s.consoles[tabId]?.run;
    if (run?.kind !== "Finished" || run.runId !== req.runId) continue;
    sent.delete(tabId);
    if (textOf(tabId) !== req.text) continue;
    const failed = run.statements.find((st) => st.status.kind === "Failed");
    if (failed?.status.kind !== "Failed") continue;
    const { position, message } = failed.status.error;
    if (position === null) continue;
    const word = /^[\w."$]+/.exec(req.text.slice(position))?.[0].length ?? 1;
    const from = Math.min(position, req.text.length);
    showDiagnostics(tabId, [{ from, to: Math.min(from + word, req.text.length), severity: "error", message }]);
  }
}

const docListeners = new Set<() => void>();
export function onEditorDocChanged(listener: () => void): () => void {
  docListeners.add(listener);
  return () => docListeners.delete(listener);
}

let markTimer: ReturnType<typeof setTimeout> | undefined;
let marking = false;
let markAgain = false;

function refreshRunMark(): void {
  clearTimeout(markTimer);
  markTimer = setTimeout(() => void markRunTarget(), 30);
}

// One outline request at a time; changes made while it is out run one more pass when it returns.
async function markRunTarget(): Promise<void> {
  if (marking) {
    markAgain = true;
    return;
  }
  marking = true;
  try {
    do {
      markAgain = false;
      await markOnce();
    } while (markAgain);
  } finally {
    marking = false;
  }
}

async function markOnce(): Promise<void> {
  const id = ws().active;
  const tab = id ? ws().tabs[id] : undefined;
  if (!id || !tab) return;
  const state = editorStateOf(id);
  const sel = state.selection.main;
  if (isBrowsing(tab) || !sel.empty) return showRunTarget(id, null);
  const outline = await commands.scriptOutline(state.doc.toString(), sel.head);
  const now = editorStateOf(id);
  // A stale reply is dropped: the change that made it stale already scheduled a newer pass.
  if (ws().active !== id || now.doc !== state.doc || !now.selection.main.empty || now.selection.main.head !== sel.head) return;
  showRunTarget(id, outline.atCursor === null ? null : (outline.statements[outline.atCursor] ?? null));
}

function runQueuedPages(s: ReturnType<typeof useLive.getState>) {
  for (const [tabId, target] of queuedPages) {
    if (isRunning(s.consoles[tabId])) continue;
    queuedPages.delete(tabId);
    void runTab(tabId, target);
  }
}

export function installRunBehavior(): void {
  useLive.subscribe(showRunErrors);
  useLive.subscribe(runQueuedPages);
  useWorkspace.subscribe((s, prev) => {
    if (s.active !== prev.active) refreshRunMark();
  });
  installEditorBehavior([
    Prec.highest(
      keymap.of([
        { key: "Mod-Enter", run: () => (runActive(), true) },
        { key: "Mod-Shift-Enter", run: () => (void chooseAndRun(), true) },
        { key: "Escape", run: () => cancelActive() },
      ]),
    ),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) for (const l of docListeners) l();
      if (u.docChanged || u.selectionSet) {
        ws().setCursor(cursorOf(u.state));
        refreshRunMark();
      }
    }),
  ]);
}

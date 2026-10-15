import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  commands,
  type ConsoleConfig,
  type DatabaseRef,
  type RunRequest,
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
import { EMPTY_QUERY, nextUntitled, tabTarget, useWorkspace, type ConsoleTarget, type RelationRef, type Tab, type TableTab } from "../../state/workspace";
import {
  dropEditor,
  editorStateOf,
  flashRanges,
  installEditorBehavior,
  seedEditor,
  showDiagnostics,
  textOf,
} from "./editorStates";
import { sqlIdent } from "./sqlIdent";

const ws = () => useWorkspace.getState();
const notify = (text: string) => ws().notify(text);

function consoleConfig(tab: Tab): ConsoleConfig | null {
  const db = tabTarget(tab);
  if (!db) return null;
  return { connectionId: db.connectionId, database: db.database, schema: null, mode: tab.kind === "sql" ? tab.console.mode : "AutoCommit" };
}

function sameConfig(a: ConsoleConfig, b: ConsoleConfig): boolean {
  return a.connectionId === b.connectionId && a.database === b.database && a.schema === b.schema && a.mode === b.mode;
}

async function ensureConsole(tab: Tab): Promise<boolean> {
  const config = consoleConfig(tab);
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

export function isBrowsing(tab: TableTab): boolean {
  return textOf(tab.id).trim().replace(/;$/, "") === browseQuery(tab.schema, tab.table);
}

type PageTarget = { page: number; exactRowCount?: number };

// A page change is saved on the tab only once the engine accepts the run. One that arrives mid-run waits for that
// run to finish, and the latest one wins. It runs only as a page load, never as the editor's script.
const queuedPages = new Map<TabId, PageTarget>();

async function runTab(tabId: TabId, target?: PageTarget): Promise<void> {
  const tab = ws().tabs[tabId];
  if (!tab) return;
  if (target && (tab.kind !== "table" || !isBrowsing(tab))) return;
  if (isRunning(useLive.getState().consoles[tabId])) {
    if (target) queuedPages.set(tabId, target);
    return;
  }
  if (!(await ensureConsole(tab))) return;

  let request: RunRequest;
  let text = "";
  if (tab.kind === "table" && isBrowsing(tab)) {
    request = { kind: "tablePage", schema: tab.schema, table: tab.table, page: target?.page ?? tab.page, query: tab.query };
  } else {
    const state = editorStateOf(tabId);
    const sel = state.selection.main;
    text = state.doc.toString();
    request = {
      kind: "script",
      text,
      target: sel.empty ? { kind: "cursor", offset: sel.head } : { kind: "selection", from: sel.from, to: sel.to },
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

export function runActive(): void {
  const id = ws().active;
  if (id) void runTab(id);
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
  if (tab?.kind !== "sql") return;
  const next = { ...tab.console, ...patch };
  if (next.db && useLive.getState().consoles[tabId]) {
    const res = await commands.consoleConfigure(tabId, { connectionId: next.db.connectionId, database: next.db.database, schema: null, mode: next.mode });
    if (res.status === "error") {
      notify(configureErrorText(res.error));
      return;
    }
  }
  ws().patchSqlConsole(tabId, patch);
}

export const setTabMode = (tabId: TabId, mode: TxnMode) => reconfigure(tabId, { mode });
export const setTabTarget = (tabId: TabId, db: DatabaseRef) => reconfigure(tabId, { db });

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
    kind: "sql",
    id,
    title: opts.title ?? nextUntitled(Object.values(ws().tabs)),
    console: { db: opts.db ?? defaultTarget(), mode: "AutoCommit" },
  });
  return id;
}

function showResults() {
  if (!ws().layout.results) ws().setLayout({ results: true });
}

export function openTableTab(ref: RelationRef): void {
  const existing = Object.values(ws().tabs).find((t) => t.kind === "table" && sameDb(t.db, ref.db) && t.schema === ref.schema && t.table === ref.relation);
  ws().select(ref);
  showResults();
  if (existing) {
    ws().setActive(existing.id);
    return;
  }
  const id = crypto.randomUUID();
  seedEditor(id, browseQuery(ref.schema, ref.relation));
  ws().addTab({ kind: "table", id, db: ref.db, schema: ref.schema, table: ref.relation, page: 0, query: EMPTY_QUERY });
}

const loadedTables = new Set<TabId>();

export function loadTableOnce(tabId: TabId): void {
  if (loadedTables.has(tabId)) return;
  loadedTables.add(tabId);
  if (useLive.getState().consoles[tabId]?.run.kind !== "Finished") void runTab(tabId);
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
  for (const tab of Object.values(ws().tabs)) if (tab.kind === "table") setTablePage(tab.id, 0);
}

export async function lastTablePage(tabId: TabId): Promise<void> {
  const tab = ws().tabs[tabId];
  if (tab?.kind !== "table") return;
  const res = await commands.exactRowCount(tab.db, tab.schema, tab.table, tab.query);
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
  if (tab?.kind !== "table") return;
  ws().setTableQuery(tabId, update(tab.query));
  void runTab(tabId, { page: 0 });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function tablePrimaryKey(tab: Pick<TableTab, "db" | "schema" | "table">): string[] {
  const rel = findRelation(viewFor(useCatalog.getState().views, tab.db), tab.schema, tab.table);
  return rel?.kind === "Table" ? rel.columns.filter((c) => c.pk).map((c) => c.name) : [];
}

export async function submitEdits(tabId: TabId): Promise<void> {
  const tab = ws().tabs[tabId];
  const edits = useTableEdits.getState().byTab[tabId];
  if (tab?.kind !== "table" || !edits || pendingCount(edits) === 0) return;
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
  const { changes, rowOf } = toChanges(edits, tab.schema, tab.table, tablePrimaryKey(tab));
  const res = await commands.tableApply(tabId, changes);
  if (res.status === "error") {
    const failedAt = "change" in res.error ? rowOf(res.error.change) : null;
    useTableEdits.setState((s) => ({ byTab: { ...s.byTab, [tabId]: { ...edits, failedAt } } }));
    notify(applyErrorText(res.error));
    return;
  }
  useTableEdits.getState().clear(tabId);
  notify(res.data.committed ? `Saved ${plural(count, "change")}.` : `${plural(count, "change")} wait in the open transaction. Commit to keep them.`);
  void runTab(tabId, { page: tab.page });
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
  installEditorBehavior([
    Prec.highest(
      keymap.of([
        { key: "Mod-Enter", run: () => (runActive(), true) },
        { key: "Escape", run: () => cancelActive() },
      ]),
    ),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) for (const l of docListeners) l();
      if (u.docChanged || u.selectionSet) {
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head);
        ws().setCursor(line.number, head - line.from + 1);
      }
    }),
  ]);
}

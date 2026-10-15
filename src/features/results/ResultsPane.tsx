import * as Menu from "@radix-ui/react-dropdown-menu";
import { save } from "@tauri-apps/plugin-dialog";
import {
  IconAlertCircle,
  IconArrowBackUp,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronLeftPipe,
  IconChevronRight,
  IconChevronRightPipe,
  IconDownload,
  IconMinus,
  IconPlus,
  IconTerminal2,
  IconUpload,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { commands, type OutputEntry, type QueryError, type ResultMeta, type RunState, type TabId } from "../../ipc/bindings";
import { exportErrorText } from "../../ipc/errors";
import { useLive } from "../../state/live";
import {
  outputTone,
  resultView,
  rowResults,
  runStatements,
  runSummary,
  shownResult,
  type ResultView,
  type Summary,
} from "../../state/status";
import { useCatalog, viewFor } from "../../state/catalog";
import { NO_EDITS, pendingCount, useTableEdits } from "../../state/tableEdits";
import { isFiltered, useWorkspace, type TableTab } from "../../state/workspace";
import { cx, IconButton, MenuContent, MenuItem, Spinner } from "../../ui/primitives";
import {
  isBrowsing,
  lastTablePage,
  loadTableOnce,
  onEditorDocChanged,
  saveSettings,
  setTablePage,
  submitEdits,
  tablePrimaryKey,
  updateTableQuery,
} from "../editor/runActions";
import { FilterBar } from "./FilterBar";
import { groupDigits, pageStatus, pluralRows } from "./format";
import { ErrorBlock, OutputPanel } from "./OutputPanel";
import { ResultGrid, type GridActions, type GridEditing, type GridQuery } from "./ResultGrid";
import { filterForValue, formatOrderBy, nextSort, parseOrderBy, useFilterDrafts } from "./tableQuery";

const NO_OUTPUT: readonly OutputEntry[] = [];

const EXPORT_FORMATS = [
  { label: "CSV", ready: true },
  { label: "JSON", ready: false },
  { label: "Markdown", ready: false },
  { label: "XML", ready: false },
];

const PAGE_SIZES = [10, 100, 250, 500, 1000];
const PAGER_INSET = 52;

function TablePager({ tab, rows }: { tab: TableTab; rows: number }) {
  const size = useWorkspace((s) => s.settings.tablePageSize);
  const estimate = useCatalog(
    (s) =>
      viewFor(s.views, tab.db)?.catalog.schemas.find((sc) => sc.name === tab.schema)?.relations.find((r) => r.name === tab.table)
        ?.rowEstimate ?? null,
  );
  const { label, isLast } = pageStatus(tab.page, size, rows, isFiltered(tab.query) ? null : estimate, tab.exactRowCount);
  return (
    <div
      data-testid="table-pager"
      className="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-control bg-raised p-1 text-ui-12.5 text-muted shadow-[var(--shadow-float)]"
    >
      <IconButton aria-label="First page" disabled={tab.page === 0} onClick={() => setTablePage(tab.id, 0)}>
        <IconChevronLeftPipe size={15} />
      </IconButton>
      <IconButton aria-label="Previous page" disabled={tab.page === 0} onClick={() => setTablePage(tab.id, tab.page - 1)}>
        <IconChevronLeft size={15} />
      </IconButton>
      <Menu.Root modal={false}>
        <Menu.Trigger
          data-testid="table-page"
          aria-label="Rows per page"
          className="inline-flex h-7 items-center gap-1 rounded-md pr-1.5 pl-2 whitespace-nowrap text-fg tabular-nums outline-none hover:bg-hover data-[state=open]:bg-hover"
        >
          {label}
          <IconChevronDown size={13} className="text-muted" />
        </Menu.Trigger>
        <MenuContent align="end">
          {PAGE_SIZES.map((n) => (
            <MenuItem key={n} testId={`page-size-${n}`} checked={n === size} onSelect={() => void saveSettings({ tablePageSize: n })}>
              {groupDigits(String(n))} per page
            </MenuItem>
          ))}
        </MenuContent>
      </Menu.Root>
      <IconButton aria-label="Next page" disabled={isLast} onClick={() => setTablePage(tab.id, tab.page + 1)}>
        <IconChevronRight size={15} />
      </IconButton>
      <IconButton aria-label="Last page" disabled={isLast} onClick={() => void lastTablePage(tab.id)}>
        <IconChevronRightPipe size={15} />
      </IconButton>
    </div>
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function SummaryText({ summary }: { summary: Summary }) {
  return (
    <span
      data-testid="result-status"
      data-tone={summary.tone}
      className={cx("flex min-w-0 items-center gap-1.5 text-ui-13", summary.tone === "error" ? "text-danger" : "text-dim")}
    >
      {summary.tone === "ok" && <IconCheck size={15} className="shrink-0 text-green" />}
      {summary.tone === "error" && <IconAlertCircle size={14} className="shrink-0" />}
      {summary.tone === "running" && <Spinner />}
      <span className="truncate">{summary.text}</span>
    </span>
  );
}

function CursorPosition() {
  const { line, col } = useWorkspace((s) => s.cursor);
  return (
    <span data-testid="cursor-position" className="text-ui-12.5 whitespace-nowrap text-dim tabular-nums">
      Ln {line}, Col {col}
    </span>
  );
}

async function exportCsv(meta: ResultMeta) {
  const notify = useWorkspace.getState().notify;
  let path: string | null;
  try {
    path = await save({ defaultPath: "result.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
  } catch {
    notify("Export needs the desktop app's save dialog.");
    return;
  }
  if (!path) return;
  const res = await commands.resultExportCsv(meta.ref, path);
  if (res.status === "error") notify(exportErrorText(res.error));
  else notify(`Exported ${pluralRows(res.data.rows)} to ${path}${res.data.truncated ? " (truncated at the row limit)" : ""}.`);
}

function ErrorPanel({ error }: { error: QueryError }) {
  return (
    <div className="selectable flex-1 overflow-auto bg-bg px-5 py-4 text-ui-13 leading-6">
      <ErrorBlock error={error} />
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="grid flex-1 place-items-center bg-bg text-ui-13 text-dim">{children}</div>;
}

function EditBar({ tabId, editable, actions }: { tabId: TabId | null; editable: boolean; actions: RefObject<GridActions | null> }) {
  const edits = useTableEdits((s) => (tabId ? s.byTab[tabId] : undefined) ?? NO_EDITS);
  const pending = editable ? pendingCount(edits) : 0;
  const busy = useTableEdits((s) => (tabId ? s.submitting[tabId] === true : false));
  return (
    <div data-testid="edit-bar" className="flex items-center gap-0.5">
      <IconButton data-testid="add-row" aria-label="Add row" title="Add row" disabled={!editable} onClick={() => actions.current?.addRow()}>
        <IconPlus size={16} />
      </IconButton>
      <IconButton
        data-testid="delete-rows"
        aria-label="Delete selected rows"
        title="Delete or restore the selected rows (⌘⌫)"
        disabled={!editable}
        onClick={() => actions.current?.deleteSelectedRows()}
      >
        <IconMinus size={16} />
      </IconButton>
      <IconButton
        data-testid="submit-edits"
        aria-label="Submit changes"
        title="Submit changes (⌘S)"
        disabled={pending === 0 || busy}
        className={cx(pending > 0 && "text-green!")}
        onClick={() => tabId && void submitEdits(tabId)}
      >
        <IconCheck size={16} />
      </IconButton>
      <IconButton
        data-testid="revert-edits"
        aria-label="Revert changes"
        title="Revert changes"
        disabled={pending === 0 || busy}
        onClick={() => tabId && useTableEdits.getState().clear(tabId)}
      >
        <IconArrowBackUp size={16} />
      </IconButton>
      {pending > 0 && (
        <span data-testid="pending-count" className="ml-1.5 text-ui-12.5 whitespace-nowrap text-amber">
          {pending} pending
        </span>
      )}
    </div>
  );
}

function failedError(run: RunState): QueryError | undefined {
  if (run.kind !== "Finished") return undefined;
  const failed = run.statements.find((s) => s.status.kind === "Failed");
  return failed?.status.kind === "Failed" ? failed.status.error : undefined;
}

function RunTail({ run }: { run: RunState }) {
  if (run.kind === "Idle") return "Run a statement with ⌘↵ to see its result here.";
  if (run.kind === "Running") {
    return (
      <span className="flex items-center gap-2">
        <Spinner /> Running
      </span>
    );
  }
  const error = failedError(run);
  if (error) return <ErrorBlock error={error} />;
  if (run.outcome === "Cancelled") return "Cancelled.";
  const commands = runStatements(run).flatMap((s) => (s.status.kind === "Command" ? [s.status.tag] : []));
  if (commands.length) return commands.join(", ");
  return rowResults(run).length ? null : "The statement returned no rows.";
}

function ResultBody({
  run,
  view,
  output,
  bottomInset,
  query,
  editing,
  actions,
}: {
  run: RunState;
  view: ResultView;
  output: readonly OutputEntry[];
  bottomInset: number;
  query: GridQuery | null;
  editing: GridEditing | null;
  actions: RefObject<GridActions | null>;
}) {
  switch (view.kind) {
    case "rows":
      return (
        <ResultGrid
          key={`${view.result.meta.ref.runId}:${view.result.index}`}
          meta={view.result.meta}
          done={view.result.done}
          bottomInset={bottomInset}
          query={query}
          editing={editing}
          actionsRef={actions}
        />
      );
    case "output":
      return <OutputPanel entries={output} />;
    case "tail": {
      const error = failedError(run);
      if (error) return <ErrorPanel error={error} />;
      return (
        <Empty>
          <RunTail run={run} />
        </Empty>
      );
    }
    default: {
      const unreachable: never = view;
      return unreachable;
    }
  }
}

export function ResultsPane({ tabId }: { tabId: TabId | null }) {
  const tab = useWorkspace((s) => (tabId ? s.tabs[tabId] : undefined));
  const picked = useWorkspace((s) => (tabId ? s.activeResult[tabId] : undefined));
  const setActiveResult = useWorkspace((s) => s.setActiveResult);
  const run = useLive((s) => (tabId ? s.consoles[tabId]?.run : undefined)) ?? { kind: "Idle" as const };
  const now = useNow(run.kind === "Running");
  const results = rowResults(run);
  const shown = shownResult(run, picked);
  const summary = runSummary(run, picked, now);
  const output = useLive((s) => (tabId ? s.output[tabId] : undefined)) ?? NO_OUTPUT;
  const view = resultView(run, picked, output.length > 0);
  const tone = outputTone(output);
  const outputPick = run.kind === "Idle" ? undefined : { kind: "output" as const, runId: run.runId, result: shown?.index };

  const isTable = tab?.kind === "table";
  const browsingNow = () => tab?.kind === "table" && isBrowsing(tab);
  const browsing = useSyncExternalStore(onEditorDocChanged, browsingNow, browsingNow);
  const browsingTable = tab?.kind === "table" && browsing ? tab : null;
  const pager = browsingTable && view.kind === "rows" ? browsingTable : null;
  const addDraft = useFilterDrafts((s) => s.add);
  const gridQuery: GridQuery | null = browsingTable && {
    sort: parseOrderBy(browsingTable.query.orderBy) ?? [],
    filtered: new Set(browsingTable.query.filters.map((f) => f.column)),
    onSort: (column, additive) =>
      updateTableQuery(browsingTable.id, (q) => ({ ...q, orderBy: formatOrderBy(nextSort(parseOrderBy(q.orderBy) ?? [], column, additive)) })),
    onFilterColumn: (column) => addDraft(browsingTable.id, column),
    onFilterValue: (column, value, negate) =>
      updateTableQuery(browsingTable.id, (q) => ({ ...q, filters: [...q.filters, filterForValue(column, value, negate)] })),
  };
  useEffect(() => {
    if (tabId && isTable) loadTableOnce(tabId);
  }, [tabId, isTable]);
  const catalogView = useCatalog((s) => viewFor(s.views, browsingTable?.db));
  const editing = useMemo<GridEditing | null>(() => {
    const pkColumns = browsingTable && catalogView ? tablePrimaryKey(browsingTable) : [];
    return pkColumns.length ? { pkColumns } : null;
  }, [browsingTable?.db, browsingTable?.schema, browsingTable?.table, catalogView]);
  const actions = useRef<GridActions | null>(null);

  return (
    <section className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex h-[41px] shrink-0 items-center gap-3 border-b border-grid pr-2 pl-2.5">
        <EditBar tabId={tabId} editable={editing !== null && tabId !== null} actions={actions} />
        {results.length > 1 && (
          <div data-testid="result-selector" className="flex items-center gap-0.5 rounded-md border border-control p-0.5">
            {results.map((r, i) => (
              <button
                key={r.index}
                type="button"
                data-testid={`result-pick-${r.index}`}
                title={`Statement ${r.index + 1} · ${pluralRows(r.meta.rowCount)}`}
                onClick={() => tabId && setActiveResult(tabId, r.index)}
                className={cx(
                  "h-5 min-w-6 rounded px-1.5 font-mono text-ui-11.5",
                  view.kind === "rows" && view.result.index === r.index ? "bg-pill text-fg" : "text-dim hover:text-muted",
                )}
              >
                {i + 1}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1" />

        {summary && <SummaryText summary={summary} />}
        {tab?.kind === "sql" && <CursorPosition />}

        <div className="flex items-center gap-0.5">
          <Menu.Root modal={false}>
            <Menu.Trigger
              data-testid="export-format"
              aria-label="Export format"
              className="inline-flex h-7 items-center gap-1 rounded-md pr-1.5 pl-2 text-ui-12.5 text-muted outline-none hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg"
            >
              CSV
              <IconChevronDown size={13} />
            </Menu.Trigger>
            <MenuContent align="end">
              {EXPORT_FORMATS.map((f) => (
                <MenuItem key={f.label} testId={`export-format-${f.label}`} checked={f.ready} disabled={!f.ready}>
                  {f.label}
                  {!f.ready && <span className="ml-auto pl-4 text-ui-11.5 text-dim">Soon</span>}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu.Root>
          <IconButton
            data-testid="export-btn"
            aria-label="Export CSV"
            title="Export CSV"
            disabled={!shown || run.kind === "Running"}
            onClick={() => shown && void exportCsv(shown.meta)}
          >
            <IconDownload size={16} />
          </IconButton>
          <IconButton
            data-testid="import-btn"
            aria-label="Import"
            title="Import"
            onClick={() => useWorkspace.getState().notify("Import is coming soon.")}
          >
            <IconUpload size={16} />
          </IconButton>
          <IconButton
            data-testid="output-toggle"
            data-tone={tone}
            aria-label="Output"
            title="Output"
            aria-pressed={view.kind === "output"}
            disabled={output.length === 0 || !tabId}
            onClick={() => {
              const pick = view.kind === "output" ? (shown?.index ?? 0) : outputPick;
              if (tabId && pick !== undefined) setActiveResult(tabId, pick);
            }}
            className={cx(view.kind === "output" && "bg-pill!", tone === "warn" ? "text-amber!" : view.kind === "output" && "text-fg!")}
          >
            <IconTerminal2 size={16} />
          </IconButton>
        </div>
      </div>

      {browsingTable && <FilterBar tab={browsingTable} />}

      <div className="relative flex min-h-0 flex-1 flex-col">
        <ResultBody run={run} view={view} output={output} bottomInset={pager ? PAGER_INSET : 0} query={gridQuery} editing={editing} actions={actions} />
        {pager && <TablePager tab={pager} rows={shown?.meta.rowCount ?? 0} />}
      </div>
    </section>
  );
}

import * as Menu from "@radix-ui/react-dropdown-menu";
import { save } from "@tauri-apps/plugin-dialog";
import { IconAlertCircle, IconCheck, IconChevronDown, IconChevronLeft, IconChevronLeftPipe, IconChevronRight, IconChevronRightPipe, IconDownload, IconUpload } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { commands, type QueryError, type ResultMeta, type RunState, type TabId } from "../../ipc/bindings";
import { exportErrorText } from "../../ipc/errors";
import { useLive } from "../../state/live";
import { rowResults, runStatements, runSummary, shownResult, type Summary } from "../../state/status";
import { useCatalog } from "../../state/catalog";
import { useWorkspace, type TableTab } from "../../state/workspace";
import { cx, IconButton, MenuContent, MenuItem, Spinner } from "../../ui/primitives";
import { isBrowsing, lastTablePage, loadTableOnce, setTablePage, setTablePageSize } from "../editor/runActions";
import { groupDigits, pageStatus, pluralRows } from "./format";
import { ResultGrid } from "./ResultGrid";

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
      s.views[tab.connectionId]?.catalog.schemas.find((sc) => sc.name === tab.schema)?.relations.find((r) => r.name === tab.table)
        ?.rowEstimate ?? null,
  );
  const { label, isLast } = pageStatus(tab.page, size, rows, estimate, tab.exactRowCount);
  return (
    <div
      data-testid="table-pager"
      className="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-control bg-raised p-1 text-[12.5px] text-muted shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
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
            <MenuItem key={n} testId={`page-size-${n}`} checked={n === size} onSelect={() => void setTablePageSize(tab.id, n)}>
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
      className={cx("flex min-w-0 items-center gap-1.5 text-[13px]", summary.tone === "error" ? "text-danger" : "text-dim")}
    >
      {summary.tone === "ok" && <IconCheck size={15} className="shrink-0 text-green" />}
      {summary.tone === "error" && <IconAlertCircle size={14} className="shrink-0" />}
      {summary.tone === "running" && <Spinner />}
      <span className="truncate">{summary.text}</span>
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
    <div className="selectable flex-1 overflow-auto bg-results px-5 py-4 text-[13px] leading-6">
      <div className="text-danger">{error.message}</div>
      {error.detail && <div className="text-muted">{error.detail}</div>}
      {error.hint && <div className="text-muted">Hint: {error.hint}</div>}
      {error.context && <div className="whitespace-pre-wrap text-dim">Context: {error.context}</div>}
      {error.sqlstate && <div className="font-mono text-[11.5px] text-faint">SQLSTATE {error.sqlstate}</div>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="grid flex-1 place-items-center bg-results text-[13px] text-dim">{children}</div>;
}

function ResultBody({ run, picked, bottomInset }: { run: RunState; picked: number | undefined; bottomInset: number }) {
  const shown = shownResult(run, picked);
  if (shown) return <ResultGrid key={`${shown.meta.ref.runId}:${shown.index}`} meta={shown.meta} done={shown.done} bottomInset={bottomInset} />;
  if (run.kind === "Idle") return <Empty>Run a statement with ⌘↵ to see its result here.</Empty>;
  if (run.kind === "Running") {
    return (
      <Empty>
        <span className="flex items-center gap-2">
          <Spinner /> Running
        </span>
      </Empty>
    );
  }
  const failed = run.statements.find((s) => s.status.kind === "Failed");
  if (failed?.status.kind === "Failed") return <ErrorPanel error={failed.status.error} />;
  if (run.outcome === "Cancelled") return <Empty>Cancelled.</Empty>;
  const commands = runStatements(run).flatMap((s) => (s.status.kind === "Command" ? [s.status.tag] : []));
  return <Empty>{commands.length ? commands.join(", ") : "The statement returned no rows."}</Empty>;
}

export function ResultsPane({ tabId }: { tabId: TabId }) {
  const tab = useWorkspace((s) => s.tabs[tabId]);
  const picked = useWorkspace((s) => s.activeResult[tabId]);
  const setActiveResult = useWorkspace((s) => s.setActiveResult);
  const run = useLive((s) => s.consoles[tabId]?.run) ?? { kind: "Idle" as const };
  const now = useNow(run.kind === "Running");
  const results = rowResults(run);
  const shown = shownResult(run, picked);
  const summary = runSummary(run, picked, now);

  const isTable = tab?.kind === "table";
  const pager = tab?.kind === "table" && isBrowsing(tab) && shown ? tab : null;
  useEffect(() => {
    if (isTable) loadTableOnce(tabId);
  }, [tabId, isTable]);

  return (
    <section className="flex h-full min-h-0 flex-col border-b border-border bg-results">
      <div className="flex h-[41px] shrink-0 items-center gap-3 border-b border-grid pr-2 pl-2.5">
        {results.length > 1 && (
          <div data-testid="result-selector" className="flex items-center gap-0.5 rounded-md border border-control p-0.5">
            {results.map((r, i) => (
              <button
                key={r.index}
                type="button"
                data-testid={`result-pick-${r.index}`}
                title={`Statement ${r.index + 1} · ${pluralRows(r.meta.rowCount)}`}
                onClick={() => setActiveResult(tabId, r.index)}
                className={cx(
                  "h-5 min-w-6 rounded px-1.5 font-mono text-[11.5px]",
                  shown?.index === r.index ? "bg-pill text-fg" : "text-dim hover:text-muted",
                )}
              >
                {i + 1}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1" />

        {summary && <SummaryText summary={summary} />}

        <div className="flex items-center gap-0.5">
          <Menu.Root modal={false}>
            <Menu.Trigger
              data-testid="export-format"
              aria-label="Export format"
              className="inline-flex h-7 items-center gap-1 rounded-md pr-1.5 pl-2 text-[12.5px] text-muted outline-none hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg"
            >
              CSV
              <IconChevronDown size={13} />
            </Menu.Trigger>
            <MenuContent align="end">
              {EXPORT_FORMATS.map((f) => (
                <MenuItem key={f.label} testId={`export-format-${f.label}`} checked={f.ready} disabled={!f.ready}>
                  {f.label}
                  {!f.ready && <span className="ml-auto pl-4 text-[11.5px] text-dim">Soon</span>}
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
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <ResultBody run={run} picked={picked} bottomInset={pager ? PAGER_INSET : 0} />
        {pager && <TablePager tab={pager} rows={shown?.meta.rowCount ?? 0} />}
      </div>
    </section>
  );
}

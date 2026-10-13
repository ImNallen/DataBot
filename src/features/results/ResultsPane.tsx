import { save } from "@tauri-apps/plugin-dialog";
import { Check, ChevronLeft, ChevronRight, CircleAlert, Download } from "lucide-react";
import { useEffect, useState } from "react";
import { commands, type QueryError, type ResultMeta, type RunState, type TabId } from "../../ipc/bindings";
import { exportErrorText } from "../../ipc/errors";
import { useLive } from "../../state/live";
import { rowResults, runStatements, runSummary, shownResult, type Summary } from "../../state/status";
import { useWorkspace } from "../../state/workspace";
import { Button, cx, IconButton, Spinner } from "../../ui/primitives";
import { loadTableOnce, setTablePage } from "../editor/runActions";
import { pluralRows } from "./format";
import { OutputLog } from "./OutputLog";
import { ResultGrid } from "./ResultGrid";

type Pane = "result" | "output";

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
      {summary.tone === "ok" && <Check size={15} className="shrink-0 text-green" />}
      {summary.tone === "error" && <CircleAlert size={14} className="shrink-0" />}
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
      {error.sqlstate && <div className="font-mono text-[11.5px] text-faint">SQLSTATE {error.sqlstate}</div>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="grid flex-1 place-items-center bg-results text-[13px] text-dim">{children}</div>;
}

function ResultBody({ run, picked }: { run: RunState; picked: number | undefined }) {
  const shown = shownResult(run, picked);
  if (shown) return <ResultGrid key={`${shown.meta.ref.runId}:${shown.index}`} meta={shown.meta} done={shown.done} />;
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
  const [pane, setPane] = useState<Pane>("result");
  const tab = useWorkspace((s) => s.tabs[tabId]);
  const picked = useWorkspace((s) => s.activeResult[tabId]);
  const setActiveResult = useWorkspace((s) => s.setActiveResult);
  const pageSize = useWorkspace((s) => s.settings.tablePageSize);
  const run = useLive((s) => s.consoles[tabId]?.run) ?? { kind: "Idle" as const };
  const now = useNow(run.kind === "Running");
  const results = rowResults(run);
  const shown = shownResult(run, picked);
  const summary = runSummary(run, picked, now);
  const failedRun = run.kind === "Finished" && run.outcome === "Failed";

  const isTable = tab?.kind === "table";
  useEffect(() => {
    if (isTable) loadTableOnce(tabId);
  }, [tabId, isTable]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-results">
      <div className="flex h-[41px] shrink-0 items-center gap-3 border-b border-grid pr-2 pl-2.5">
        <div className="flex items-center gap-1" role="tablist">
          {(["result", "output"] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={pane === p}
              data-testid={`pane-${p}`}
              onClick={() => setPane(p)}
              className={cx(
                "h-7 rounded-md px-2.5 text-[13.5px]",
                pane === p ? "bg-pill text-fg" : "text-dim hover:text-muted",
                p === "output" && failedRun && pane !== p && "text-danger/80",
              )}
            >
              {p === "result" ? "Result" : "Output"}
            </button>
          ))}
        </div>

        {pane === "result" && results.length > 1 && (
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

        {tab?.kind === "table" && (
          <div className="flex items-center gap-1 text-[12.5px] text-dim">
            <IconButton aria-label="Previous page" disabled={tab.page === 0} onClick={() => setTablePage(tabId, tab.page - 1)}>
              <ChevronLeft size={15} />
            </IconButton>
            <span data-testid="table-page" className="tabular-nums">
              Page {tab.page + 1}
            </span>
            <IconButton
              aria-label="Next page"
              disabled={!shown || shown.meta.rowCount < pageSize}
              onClick={() => setTablePage(tabId, tab.page + 1)}
            >
              <ChevronRight size={15} />
            </IconButton>
          </div>
        )}

        {summary && <SummaryText summary={summary} />}

        <Button
          data-testid="export-btn"
          className="h-[30px] gap-2 px-2.5 text-[#d4d4d4]"
          disabled={!shown || run.kind === "Running"}
          onClick={() => shown && void exportCsv(shown.meta)}
        >
          <Download size={14} className="text-green" />
          Export
        </Button>
      </div>

      {pane === "result" ? <ResultBody run={run} picked={picked} /> : <OutputLog tabId={tabId} />}
    </section>
  );
}

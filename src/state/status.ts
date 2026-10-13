import type { ConnectionState, ConsoleState, ResultMeta, RunState, StatementRun } from "../ipc/bindings";
import { formatElapsed, groupDigits, pluralRows } from "../features/results/format";

/** Commit/Rollback visibility and the tab's dot share one rule: a manual transaction holds work. */
export function hasUncommittedWork(console: ConsoleState | undefined): boolean {
  return console !== undefined && console.config.mode === "Manual" && console.txn !== "Idle";
}

export function isRunning(console: ConsoleState | undefined): boolean {
  return console?.run.kind === "Running";
}

export type Tone = "live" | "pending" | "off" | "error";

export function connectionStatus(state: ConnectionState | undefined): { tone: Tone; label: string; version: string | null } {
  const status = state?.status ?? { kind: "Disconnected" as const };
  switch (status.kind) {
    case "Connected":
      return { tone: "live", label: "Connected", version: status.server.version };
    case "Connecting":
      return { tone: "pending", label: "Connecting…", version: null };
    case "Disconnected":
      return { tone: "off", label: "Disconnected", version: null };
    case "Failed":
      return { tone: "error", label: "Connection failed", version: null };
    case "Lost":
      return { tone: "error", label: "Connection lost", version: null };
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

export type RowResult = { index: number; meta: ResultMeta; done: boolean };

export function runStatements(run: RunState): StatementRun[] {
  return run.kind === "Idle" ? [] : run.statements;
}

export function rowResults(run: RunState): RowResult[] {
  const out: RowResult[] = [];
  for (const s of runStatements(run)) {
    if (s.status.kind === "Rows") out.push({ index: s.index, meta: s.status.result, done: s.status.done });
  }
  return out;
}

/** The statement whose result is shown: the user's pick when it still exists, else the last one. */
export function shownResult(run: RunState, picked: number | undefined): RowResult | undefined {
  const results = rowResults(run);
  return results.find((r) => r.index === picked) ?? results.at(-1);
}

export type Summary = { tone: "ok" | "error" | "running" | "muted"; text: string };

function rowsText(meta: ResultMeta): string {
  if (meta.truncated === null) return pluralRows(meta.rowCount);
  const why = meta.truncated === "RowLimit" ? "row limit" : "size limit";
  return `${groupDigits(String(meta.rowCount))} of ${groupDigits(String(meta.rowsSeen))} rows (${why})`;
}

export function runSummary(run: RunState, picked: number | undefined, nowMs: number): Summary | null {
  switch (run.kind) {
    case "Idle":
      return null;
    case "Running": {
      const elapsed = formatElapsed(Math.max(0, nowMs - run.startedAtMs));
      const streaming = shownResult(run, picked);
      return {
        tone: "running",
        text: streaming ? `${pluralRows(streaming.meta.rowCount)} · ${elapsed}` : `Running · ${elapsed}`,
      };
    }
    case "Finished": {
      const failed = run.statements.find((s) => s.status.kind === "Failed");
      if (failed?.status.kind === "Failed") return { tone: "error", text: failed.status.error.message };
      if (run.outcome === "Cancelled") return { tone: "muted", text: `Cancelled · ${formatElapsed(run.elapsedMs)}` };
      const shown = shownResult(run, picked);
      if (shown) return { tone: "ok", text: `${rowsText(shown.meta)} · ${formatElapsed(shown.meta.elapsedMs)}` };
      const last = run.statements.at(-1);
      if (last?.status.kind === "Command") return { tone: "ok", text: `${last.status.tag} · ${formatElapsed(last.status.elapsedMs)}` };
      return { tone: "ok", text: formatElapsed(run.elapsedMs) };
    }
    default: {
      const unreachable: never = run;
      return unreachable;
    }
  }
}

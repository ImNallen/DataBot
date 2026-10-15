import type { ConnectionState, ConsoleState, OutputEntry, ResultMeta, RunState, StatementRun } from "../ipc/bindings";
import { formatElapsed, groupDigits, plural, pluralRows } from "../features/results/format";

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

export type ResultPick = number | { kind: "messages"; runId: number };

export function shownResult(run: RunState, picked: ResultPick | undefined): RowResult | undefined {
  const results = rowResults(run);
  return results.find((r) => r.index === picked) ?? results.at(-1);
}

export function messagesSince(entries: readonly OutputEntry[] | undefined, run: RunState): OutputEntry[] {
  if (run.kind === "Idle" || !entries) return [];
  return entries.filter((e) => e.runId >= run.runId);
}

export type ResultView = { kind: "rows"; result: RowResult } | { kind: "messages" } | { kind: "tail" };

export function resultView(run: RunState, picked: ResultPick | undefined, hasMessages: boolean): ResultView {
  const pickedMessages = typeof picked === "object" && run.kind !== "Idle" && picked.runId === run.runId;
  if (hasMessages && pickedMessages) return { kind: "messages" };
  const result = shownResult(run, picked);
  if (result) return { kind: "rows", result };
  return hasMessages ? { kind: "messages" } : { kind: "tail" };
}

export function messagesLabel(entries: readonly OutputEntry[]): { text: string; tone: "muted" | "warn" } {
  const warn = entries.some((e) => e.body.kind === "Error" || (e.body.kind === "Notice" && e.body.severity === "WARNING"));
  return { text: plural(entries.length, "message"), tone: warn ? "warn" : "muted" };
}

export type Summary = { tone: "ok" | "error" | "running" | "muted"; text: string };

function rowsText(meta: ResultMeta): string {
  if (meta.truncated === null) return pluralRows(meta.rowCount);
  const why = meta.truncated === "RowLimit" ? "row limit" : "size limit";
  return `${groupDigits(String(meta.rowCount))} of ${groupDigits(String(meta.rowsSeen))} rows (${why})`;
}

export function runSummary(run: RunState, picked: ResultPick | undefined, nowMs: number): Summary | null {
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

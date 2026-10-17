import type { LimitsReport } from "../../ipc/bindings";
import { timeAgo } from "../assistant/assistantText";

/** The countdown on a limit bar: "now", "26m", "1h 26m", "3d 4h". */
export function formatReset(resetsAtMs: number | null, nowMs: number): string | null {
  if (resetsAtMs === null) return null;
  if (resetsAtMs <= nowMs) return "now";
  const minutes = Math.floor((resetsAtMs - nowMs) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function checkedText(report: LimitsReport | null, loading: boolean, nowMs: number): string {
  if (loading) return "Checking…";
  return report ? `Checked ${timeAgo(nowMs, report.checkedAtMs)}` : "";
}

/** The first reset still ahead of the read, when the page reads again. A reset the read already saw pass is left out, so a CLI that has not rolled its window yet cannot loop the reread. */
export function nextReset(report: LimitsReport): number | null {
  const resets = report.sources.flatMap(({ outcome }) =>
    outcome.kind === "Ready" ? outcome.windows.flatMap((w) => (w.resetsAtMs !== null && w.resetsAtMs > report.checkedAtMs ? [w.resetsAtMs] : [])) : [],
  );
  return resets.length > 0 ? Math.min(...resets) : null;
}

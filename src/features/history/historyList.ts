import type { HistoryBrowsePage, HistoryBrowseQuery, HistoryFilter, HistoryGroupPage, HistoryGroupSummary } from "../../ipc/bindings";

const PAGE = 50;
export type HistoryList = HistoryBrowsePage & { text: string; filter: HistoryFilter };
export type HistoryDetail = HistoryGroupPage & { id: number };

export function firstPageQuery(text: string, filter: HistoryFilter): HistoryBrowseQuery {
  return { text: text.trim() || null, filter, beforeId: null, limit: PAGE, revision: null };
}

export function olderPageQuery(list: HistoryList): HistoryBrowseQuery | null {
  const last = list.groups.at(-1);
  if (!list.hasMore || !last) return null;
  return { text: list.text || null, filter: list.filter, beforeId: last.latestId, limit: PAGE, revision: list.revision };
}

export function appendOlder(current: HistoryList, requested: HistoryList, page: HistoryBrowsePage): HistoryList {
  if (current !== requested || current.revision !== page.revision) return current;
  return { ...current, groups: [...current.groups, ...page.groups], hasMore: page.hasMore };
}

export function keepSelection(groups: HistoryGroupSummary[], selected: number | null): number | null {
  return groups.find((g) => g.id === selected)?.id ?? groups[0]?.id ?? null;
}

export function appendRuns(current: HistoryDetail, requested: HistoryDetail, page: HistoryGroupPage): HistoryDetail {
  if (current !== requested || current.revision !== page.revision) return current;
  return { ...current, runs: [...current.runs, ...page.runs], hasMore: page.hasMore };
}

export type HistoryAction = "open" | "run" | "insert" | "copy" | "next" | "previous";
export function historyKey(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing">, searchHasSelection: boolean): HistoryAction | null {
  if (e.isComposing || e.shiftKey) return null;
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === "Enter") return mod ? "run" : e.altKey ? "insert" : "open";
  if (mod && e.key.toLowerCase() === "c" && !searchHasSelection) return "copy";
  if (!mod && !e.altKey && e.key === "ArrowDown") return "next";
  if (!mod && !e.altKey && e.key === "ArrowUp") return "previous";
  return null;
}

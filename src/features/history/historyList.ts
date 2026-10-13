import type { HistoryEntry, HistoryPage, HistoryQuery } from "../../ipc/bindings";

const PAGE = 100;

/** The pages loaded so far for one search. A new search replaces the whole list. */
export type HistoryList = { text: string; entries: HistoryEntry[]; hasMore: boolean };

export function firstPageQuery(text: string): HistoryQuery {
  return { text: text || null, connectionId: null, beforeId: null, limit: PAGE };
}

export function olderPageQuery(list: HistoryList): HistoryQuery | null {
  if (!list.hasMore) return null;
  return { text: list.text || null, connectionId: null, beforeId: list.entries.at(-1)?.id ?? null, limit: PAGE };
}

// `requested` is the list the older page was fetched for. If a search or another page replaced it meanwhile, the page is stale.
export function appendOlder(current: HistoryList, requested: HistoryList, page: HistoryPage): HistoryList {
  if (current !== requested) return current;
  return { text: current.text, entries: [...current.entries, ...page.entries], hasMore: page.hasMore };
}

// Queries run after the list was fetched arrive on the live tail, newer than anything in the list.
export function withTail(list: HistoryList, tail: HistoryEntry[]): HistoryEntry[] {
  const newest = list.entries[0]?.id ?? 0;
  const needle = list.text.toLowerCase();
  const fresh = tail.filter((h) => h.id > newest && (!needle || h.sql.toLowerCase().includes(needle)));
  return [...fresh, ...list.entries];
}

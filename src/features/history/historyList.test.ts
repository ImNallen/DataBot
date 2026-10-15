import { describe, expect, it } from "vitest";
import type { HistoryBrowsePage, HistoryGroupSummary } from "../../ipc/bindings";
import { appendOlder, appendRuns, firstPageQuery, historyKey, keepSelection, olderPageQuery, type HistoryDetail, type HistoryList } from "./historyList";

const group = (id: number): HistoryGroupSummary => ({
  id, latestId: id + 10, latestAtMs: 123, connectionId: "c1", database: "shop", title: "Query", excerpt: "select 1",
  runCount: 2, failedCount: 0, isWrite: false,
  representative: { id: id + 10, atMs: 123, connectionName: "dev", elapsedMs: 20, outcome: { kind: "Rows", rows: 1 } },
});
const page = (groups: HistoryGroupSummary[], revision = 2): HistoryBrowsePage => ({ groups, counts: { all: 10, failed: 1, writes: 2 }, revision, hasMore: true });
const list = (): HistoryList => ({ ...page([group(8), group(5)]), text: "orders", filter: "Failed" });

it("pages groups with the latest id, original search, filter and revision", () => {
  expect(firstPageQuery("  orders  ", "Writes")).toEqual({ text: "orders", filter: "Writes", beforeId: null, limit: 50, revision: null });
  expect(firstPageQuery(" ", "All").text).toBeNull();
  expect(olderPageQuery(list())).toEqual({ text: "orders", filter: "Failed", beforeId: 15, limit: 50, revision: 2 });
  expect(olderPageQuery({ ...list(), hasMore: false })).toBeNull();
});

it("appends a matching group page and drops responses from replaced searches or revisions", () => {
  const current = list();
  expect(appendOlder(current, current, { ...page([group(1)]), hasMore: false }).groups.map((g) => g.id)).toEqual([8, 5, 1]);
  expect(appendOlder(current, list(), page([group(1)]))).toBe(current);
  expect(appendOlder(current, current, page([group(1)], 3))).toBe(current);
});

it("preserves exact-group selection on refresh and otherwise selects the first match", () => {
  expect(keepSelection([group(8), group(5)], 5)).toBe(5);
  expect(keepSelection([group(8), group(5)], 7)).toBe(8);
  expect(keepSelection([], 5)).toBeNull();
});

it("ignores run pages fetched before another group, page, or revision replaced the preview", () => {
  const original: HistoryDetail = { id: 5, sql: "select 1", runs: [group(5).representative], hasMore: true, maxElapsedMs: 100, revision: 2 };
  const next = { ...original, runs: [group(1).representative], hasMore: false };
  expect(appendRuns(original, original, next).runs.map((r) => r.id)).toEqual([15, 11]);
  expect(appendRuns({ ...original, id: 8 }, original, next).id).toBe(8);
  expect(appendRuns(original, original, { ...next, revision: 3 })).toBe(original);
});

describe("history keys", () => {
  const key = (key: string, modifiers: Partial<Parameters<typeof historyKey>[0]> = {}, selection = false) => historyKey({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...modifiers }, selection);
  it("selects with arrows and opens, runs or inserts with the documented keys", () => {
    expect([key("ArrowDown"), key("ArrowUp"), key("Enter"), key("Enter", { metaKey: true }), key("Enter", { ctrlKey: true }), key("Enter", { altKey: true })]).toEqual(["next", "previous", "open", "run", "run", "insert"]);
  });
  it("keeps normal search selection copying and composition intact", () => {
    expect(key("c", { metaKey: true })).toBe("copy");
    expect(key("c", { ctrlKey: true }, true)).toBeNull();
    expect(key("Enter", { isComposing: true })).toBeNull();
    expect(key("Enter", { shiftKey: true })).toBeNull();
    expect(key("Escape")).toBeNull();
  });
});

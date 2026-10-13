import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../../ipc/bindings";
import { appendOlder, firstPageQuery, olderPageQuery, withTail, type HistoryList } from "./historyList";

const entry = (id: number, sql = `select ${id}`): HistoryEntry => ({
  id,
  atMs: id * 1000,
  connectionId: "c0000000-0000-4000-8000-000000000001",
  connectionName: "shop",
  database: "shop",
  sql,
  elapsedMs: 3,
  outcome: { kind: "Rows", rows: 1 },
});

const ids = (entries: HistoryEntry[]) => entries.map((h) => h.id);

describe("history paging", () => {
  it("searches every connection from the newest entry, sending no text for an empty search", () => {
    expect(firstPageQuery("")).toEqual({ text: null, connectionId: null, beforeId: null, limit: 100 });
    expect(firstPageQuery("orders").text).toBe("orders");
  });

  it("asks for the page before the oldest loaded entry, with the same search text", () => {
    const list: HistoryList = { text: "orders", entries: [entry(9), entry(7), entry(4)], hasMore: true };
    expect(olderPageQuery(list)).toEqual({ text: "orders", connectionId: null, beforeId: 4, limit: 100 });
  });

  it("stops asking once the server says there is nothing older", () => {
    expect(olderPageQuery({ text: "", entries: [entry(2)], hasMore: false })).toBeNull();
  });

  it("appends an older page below the loaded entries", () => {
    const list: HistoryList = { text: "", entries: [entry(9), entry(8)], hasMore: true };
    const next = appendOlder(list, list, { entries: [entry(5), entry(3)], hasMore: false });
    expect(ids(next.entries)).toEqual([9, 8, 5, 3]);
    expect(next.hasMore).toBe(false);
  });

  it("drops an older page that lands after a new search replaced the list", () => {
    const before: HistoryList = { text: "", entries: [entry(9), entry(8)], hasMore: true };
    const searched: HistoryList = { text: "", entries: [entry(9)], hasMore: true };
    expect(appendOlder(searched, before, { entries: [entry(5)], hasMore: false })).toBe(searched);
  });
});

describe("history live tail", () => {
  it("puts queries run since the fetch on top, matching the search case-insensitively", () => {
    const list: HistoryList = { text: "orders", entries: [entry(5, "select * from orders")], hasMore: false };
    const tail = [entry(8, "SELECT count(*) FROM Orders"), entry(7, "select 1"), entry(5, "select * from orders"), entry(2, "orders")];
    expect(ids(withTail(list, tail))).toEqual([8, 5]);
  });
});

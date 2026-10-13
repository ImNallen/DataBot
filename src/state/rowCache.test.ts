import { describe, expect, it } from "vitest";
import type { ResultRef, RowPage } from "../ipc/bindings";
import { expectedPageLength, PAGE_SIZE, pagesFor, RowCache, type RowSource } from "./rowCache";

const REF: ResultRef = { tabId: "t", runId: 1, index: 0 };

function source(available: () => number, opts: { cutRow?: number } = {}) {
  const calls: { start: number; len: number }[] = [];
  const src: RowSource = {
    async page(_ref, start, len): Promise<RowPage> {
      calls.push({ start, len });
      const end = Math.min(available(), start + len);
      const rows = Array.from({ length: Math.max(0, end - start) }, (_, i) => [String(start + i), null]);
      const cut: [number, number][] = opts.cutRow !== undefined && opts.cutRow >= start && opts.cutRow < end ? [[opts.cutRow, 0]] : [];
      return { start, rows, cut };
    },
    async cell(_ref, row) {
      return `full ${row}`;
    },
  };
  return { src, calls };
}

describe("page math", () => {
  it("covers a window with the pages it touches, clipped to the row count", () => {
    expect(pagesFor({ start: 0, end: 30 }, 6)).toEqual([0]);
    expect(pagesFor({ start: 250, end: 260 }, 10_000)).toEqual([0, 1]);
    expect(pagesFor({ start: 512, end: 513 }, 10_000)).toEqual([2]);
    expect(pagesFor({ start: 199_990, end: 200_040 }, 200_000)).toEqual([781]);
    expect(pagesFor({ start: 10, end: 20 }, 0)).toEqual([]);
  });

  it("expects a short last page only", () => {
    expect(expectedPageLength(0, 6)).toBe(6);
    expect(expectedPageLength(0, 1_000)).toBe(PAGE_SIZE);
    expect(expectedPageLength(3, 1_000)).toBe(1_000 - 3 * PAGE_SIZE);
    expect(expectedPageLength(4, 1_000)).toBe(0);
  });
});

describe("RowCache", () => {
  it("fetches each page once and serves rows by absolute index", async () => {
    const { src, calls } = source(() => 200_000);
    const cache = new RowCache(REF, src);
    await cache.ensure({ start: 300, end: 340 }, 200_000);
    await cache.ensure({ start: 300, end: 340 }, 200_000);
    expect(calls).toEqual([{ start: 256, len: 256 }]);
    expect(cache.get(300)?.[0]).toBe("300");
    expect(cache.get(0)).toBeUndefined();
  });

  it("dedupes concurrent requests for the same page", async () => {
    const { src, calls } = source(() => 1_000);
    const cache = new RowCache(REF, src);
    await Promise.all([cache.ensure({ start: 0, end: 10 }, 1_000), cache.ensure({ start: 5, end: 20 }, 1_000)]);
    expect(calls).toHaveLength(1);
  });

  it("refetches a page that arrived short while the result was streaming", async () => {
    let streamed = 100;
    const { src, calls } = source(() => streamed);
    const cache = new RowCache(REF, src);
    await cache.ensure({ start: 0, end: 50 }, 100);
    expect(cache.get(150)).toBeUndefined();
    streamed = 400;
    await cache.ensure({ start: 0, end: 300 }, 400);
    expect(calls.map((c) => c.start)).toEqual([0, 0, 256]);
    expect(cache.get(150)?.[0]).toBe("150");
    expect(cache.get(399)?.[0]).toBe("399");
  });

  it("evicts least recently used pages beyond 64 but keeps the requested window", async () => {
    const { src } = source(() => 100_000);
    const cache = new RowCache(REF, src);
    for (let p = 0; p < 70; p++) await cache.ensure({ start: p * PAGE_SIZE, end: p * PAGE_SIZE + 1 }, 100_000);
    expect(cache.pageCount).toBe(64);
    expect(cache.get(0)).toBeUndefined();
    expect(cache.get(69 * PAGE_SIZE)?.[0]).toBe(String(69 * PAGE_SIZE));
  });

  it("marks cut cells by absolute row and loads the full value on demand", async () => {
    const { src } = source(() => 1_000, { cutRow: 300 });
    const cache = new RowCache(REF, src);
    await cache.ensure({ start: 290, end: 310 }, 1_000);
    expect(cache.isCut(300, 0)).toBe(true);
    expect(cache.isCut(301, 0)).toBe(false);
    expect(await cache.loadFull(300, 0)).toBe("full 300");
    expect(cache.fullValue(300, 0)).toBe("full 300");
  });

  it("notifies subscribers when a page lands", async () => {
    const { src } = source(() => 10);
    const cache = new RowCache(REF, src);
    let calls = 0;
    cache.subscribe(() => calls++);
    const before = cache.getVersion();
    await cache.ensure({ start: 0, end: 10 }, 10);
    expect(calls).toBe(1);
    expect(cache.getVersion()).toBeGreaterThan(before);
  });

  it("stops fetching once the result is gone", async () => {
    let calls = 0;
    const cache = new RowCache(REF, {
      async page() {
        calls++;
        return "gone";
      },
      async cell() {
        return "gone";
      },
    });
    await cache.ensure({ start: 0, end: 10 }, 10);
    await cache.ensure({ start: 0, end: 10 }, 10);
    expect(cache.gone).toBe(true);
    expect(calls).toBe(1);
  });
});

import { commands, type ResultRef, type RowPage } from "../ipc/bindings";

export const PAGE_SIZE = 256;
const MAX_PAGES = 64;

export type Row = (string | null)[];
export type RowRange = { start: number; end: number };

type Page = { rows: Row[]; cut: Set<string> };

export type RowSource = {
  page(ref: ResultRef, start: number, len: number): Promise<RowPage | "gone">;
  cell(ref: ResultRef, row: number, col: number): Promise<string | null | "gone">;
};

export const ipcRowSource: RowSource = {
  async page(ref, start, len) {
    const res = await commands.resultPage(ref, start, len);
    return res.status === "ok" ? res.data : "gone";
  },
  async cell(ref, row, col) {
    const res = await commands.resultCell(ref, row, col);
    return res.status === "ok" ? res.data : "gone";
  },
};

export function pagesFor(range: RowRange, rowCount: number): number[] {
  const end = Math.min(range.end, rowCount);
  if (end <= range.start) return [];
  const pages: number[] = [];
  for (let p = Math.floor(Math.max(0, range.start) / PAGE_SIZE); p <= Math.floor((end - 1) / PAGE_SIZE); p++) pages.push(p);
  return pages;
}

export function expectedPageLength(page: number, rowCount: number): number {
  return Math.max(0, Math.min(PAGE_SIZE, rowCount - page * PAGE_SIZE));
}

const cellKey = (row: number, col: number) => `${row}:${col}`;

export class RowCache {
  readonly ref: ResultRef;
  private readonly source: RowSource;
  private readonly pages = new Map<number, Page>();
  private readonly inflight = new Map<number, Promise<void>>();
  private readonly full = new Map<string, string | null>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  gone = false;

  constructor(ref: ResultRef, source: RowSource = ipcRowSource) {
    this.ref = ref;
    this.source = source;
  }

  get(row: number): Row | undefined {
    return this.pages.get(Math.floor(row / PAGE_SIZE))?.rows[row % PAGE_SIZE];
  }

  isCut(row: number, col: number): boolean {
    return this.pages.get(Math.floor(row / PAGE_SIZE))?.cut.has(cellKey(row, col)) ?? false;
  }

  fullValue(row: number, col: number): string | null | undefined {
    return this.full.get(cellKey(row, col));
  }

  async ensure(range: RowRange, rowCount: number): Promise<void> {
    if (this.gone) return;
    const wanted = pagesFor(range, rowCount);
    const loads = wanted
      .filter((p) => (this.pages.get(p)?.rows.length ?? -1) < expectedPageLength(p, rowCount))
      .map((p) => this.load(p, rowCount));
    for (const p of wanted) this.touch(p);
    await Promise.all(loads);
    this.evict(new Set(wanted));
  }

  async loadFull(row: number, col: number): Promise<string | null | undefined> {
    const key = cellKey(row, col);
    if (this.full.has(key)) return this.full.get(key);
    const value = await this.source.cell(this.ref, row, col);
    if (value === "gone") {
      this.markGone();
      return undefined;
    }
    this.full.set(key, value);
    this.notify();
    return value;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private load(page: number, rowCount: number): Promise<void> {
    const running = this.inflight.get(page);
    if (running) return running;
    const start = page * PAGE_SIZE;
    const promise = this.source
      .page(this.ref, start, expectedPageLength(page, rowCount))
      .then((res) => {
        if (res === "gone") return this.markGone();
        const cut = new Set(res.cut.map(([r, c]) => cellKey(r, c)));
        const prev = this.pages.get(page);
        if (!prev || prev.rows.length <= res.rows.length) this.pages.set(page, { rows: res.rows, cut });
        this.notify();
      })
      .finally(() => this.inflight.delete(page));
    this.inflight.set(page, promise);
    return promise;
  }

  private touch(page: number) {
    const p = this.pages.get(page);
    if (!p) return;
    this.pages.delete(page);
    this.pages.set(page, p);
  }

  private evict(keep: Set<number>) {
    for (const page of this.pages.keys()) {
      if (this.pages.size <= MAX_PAGES) return;
      if (!keep.has(page)) this.pages.delete(page);
    }
  }

  private markGone() {
    this.gone = true;
    this.notify();
  }

  private notify() {
    this.version++;
    for (const l of this.listeners) l();
  }

  get pageCount(): number {
    return this.pages.size;
  }
}

const caches = new Map<string, RowCache>();

export function rowCacheFor(ref: ResultRef): RowCache {
  const key = `${ref.tabId}:${ref.runId}:${ref.index}`;
  let cache = caches.get(key);
  if (!cache) {
    for (const [k, c] of caches) if (c.ref.tabId === ref.tabId && c.ref.runId !== ref.runId) caches.delete(k);
    cache = new RowCache(ref);
    caches.set(key, cache);
  }
  return cache;
}

export function dropRowCaches(tabId: string): void {
  for (const [k, c] of caches) if (c.ref.tabId === tabId) caches.delete(k);
}

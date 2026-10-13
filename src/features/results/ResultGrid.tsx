import { IconKeyFilled } from "@tabler/icons-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { ColumnMeta, ResultMeta } from "../../ipc/bindings";
import { rowCacheFor, type RowCache } from "../../state/rowCache";
import { isPrimaryKey, useCatalog } from "../../state/catalog";
import { tabConnectionId, useWorkspace } from "../../state/workspace";
import { cx } from "../../ui/primitives";
import { groupDigits, isRightAligned, toTsv } from "./format";

const ROW_H = 24;
const HEADER_H = 28;
const ROWNUM_W = 36;
const MIN_COL = 56;
const MAX_COL = 320;
const MONO_CHAR = 7.8;
const SANS_CHAR = 7.2;
const PREFETCH = 64;
const COPY_ROW_LIMIT = 50_000;

type Cell = { row: number; col: number };
type Selection = { anchor: Cell; focus: Cell } | null;

const KEY_ICON = 12;

function naturalWidths(columns: ColumnMeta[], pk: boolean[], cache: RowCache, sampleRows: number): number[] {
  return columns.map((c, i) => {
    let longest = 0;
    for (let r = 0; r < sampleRows; r++) {
      const v = cache.get(r)?.[i];
      const shown = v == null ? 4 : isRightAligned(c.type.category) ? groupDigits(v).length : Math.min(v.length, 60);
      longest = Math.max(longest, shown);
    }
    const header = c.name.length * SANS_CHAR + (pk[i] ? KEY_ICON + 4 : 0);
    const content = Math.max(header, longest * MONO_CHAR);
    return Math.round(Math.min(MAX_COL, Math.max(MIN_COL, content + 12)));
  });
}

function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

function inSelection(sel: Selection, row: number, col: number): boolean {
  if (!sel) return false;
  const r0 = Math.min(sel.anchor.row, sel.focus.row);
  const r1 = Math.max(sel.anchor.row, sel.focus.row);
  const c0 = Math.min(sel.anchor.col, sel.focus.col);
  const c1 = Math.max(sel.anchor.col, sel.focus.col);
  return row >= r0 && row <= r1 && col >= c0 && col <= c1;
}

async function copySelection(cache: RowCache, sel: NonNullable<Selection>, rowCount: number) {
  const notify = useWorkspace.getState().notify;
  const r0 = Math.min(sel.anchor.row, sel.focus.row);
  const r1 = Math.min(Math.max(sel.anchor.row, sel.focus.row), rowCount - 1);
  const c0 = Math.min(sel.anchor.col, sel.focus.col);
  const c1 = Math.max(sel.anchor.col, sel.focus.col);
  if (r1 - r0 + 1 > COPY_ROW_LIMIT) {
    notify(`Copy is limited to ${groupDigits(String(COPY_ROW_LIMIT))} rows. Use Export for the full result.`);
    return;
  }
  await cache.ensure({ start: r0, end: r1 + 1 }, rowCount);
  const rows: (string | null)[][] = [];
  for (let r = r0; r <= r1; r++) {
    const row = cache.get(r);
    const out: (string | null)[] = [];
    for (let c = c0; c <= c1; c++) out.push(cache.isCut(r, c) ? ((await cache.loadFull(r, c)) ?? null) : (row?.[c] ?? null));
    rows.push(out);
  }
  await navigator.clipboard.writeText(toTsv(rows));
  const cells = (r1 - r0 + 1) * (c1 - c0 + 1);
  if (cells > 1) notify(`Copied ${groupDigits(String(cells))} cells.`);
}

export function ResultGrid({ meta, done, bottomInset }: { meta: ResultMeta; done: boolean; bottomInset: number }) {
  const cache = rowCacheFor(meta.ref);
  useSyncExternalStore(cache.subscribe, cache.getVersion);
  const scroller = useRef<HTMLDivElement>(null);
  const viewport = useElementWidth(scroller);
  const [selection, setSelection] = useState<Selection>(null);
  const dragging = useRef(false);
  const { rowCount, columns } = meta;
  const connectionId = useWorkspace((s) => tabConnectionId(s.tabs[meta.ref.tabId]));
  const catalog = useCatalog((s) => (connectionId ? s.views[connectionId] : undefined));
  const pk = useMemo(() => columns.map((c) => isPrimaryKey(catalog, c.source)), [columns, catalog]);
  const rowNumW = Math.max(ROWNUM_W, String(rowCount).length * MONO_CHAR + 14);

  const [measured, setMeasured] = useState<number[] | null>(null);
  const sampled = Math.min(rowCount, 64);
  const sampleReady = sampled > 0 ? cache.get(sampled - 1) !== undefined : done;
  useEffect(() => {
    if (!measured && sampleReady) setMeasured(naturalWidths(columns, pk, cache, sampled));
  }, [measured, sampleReady, columns, pk, cache, sampled]);
  const widths = useMemo(() => measured ?? columns.map(() => MIN_COL), [measured, columns]);
  const fitted = useMemo(() => {
    const total = widths.reduce((a, b) => a + b, 0);
    const spare = viewport - rowNumW - total;
    if (spare <= 0 || widths.length === 0) return widths;
    const extra = Math.floor(spare / widths.length);
    return widths.map((w, i) => w + extra + (i === widths.length - 1 ? spare - extra * widths.length : 0));
  }, [widths, viewport, rowNumW]);

  const rows = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_H,
    paddingStart: HEADER_H,
    paddingEnd: bottomInset,
    overscan: 12,
  });
  const cols = useVirtualizer({
    horizontal: true,
    count: columns.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => fitted[i] ?? MIN_COL,
    paddingStart: rowNumW,
    overscan: 3,
  });
  useLayoutEffect(() => {
    cols.measure();
  }, [cols, fitted, rowNumW]);

  const virtualRows = rows.getVirtualItems();
  const firstRow = virtualRows[0]?.index ?? 0;
  const lastRow = virtualRows.at(-1)?.index ?? 0;
  useEffect(() => {
    void cache.ensure({ start: Math.max(0, firstRow - PREFETCH), end: lastRow + 1 + PREFETCH }, rowCount);
  }, [cache, firstRow, lastRow, rowCount]);

  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const openCell = async (row: number, col: number) => {
    const value = cache.isCut(row, col) ? await cache.loadFull(row, col) : cache.get(row)?.[col];
    if (value === undefined) return;
    useWorkspace.getState().open({ kind: "cell", title: `${columns[col]?.name ?? ""} · row ${row + 1}`, value });
  };

  const moveFocus = (dr: number, dc: number, extend: boolean) => {
    setSelection((sel) => {
      const from = sel?.focus ?? { row: 0, col: 0 };
      const focus = {
        row: Math.max(0, Math.min(rowCount - 1, from.row + dr)),
        col: Math.max(0, Math.min(columns.length - 1, from.col + dc)),
      };
      rows.scrollToIndex(focus.row);
      cols.scrollToIndex(focus.col);
      return { anchor: extend && sel ? sel.anchor : focus, focus };
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "c" && selection) {
      e.preventDefault();
      void copySelection(cache, selection, rowCount);
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelection({ anchor: { row: 0, col: 0 }, focus: { row: rowCount - 1, col: columns.length - 1 } });
    } else if (e.key === "Enter" && selection) {
      void openCell(selection.focus.row, selection.focus.col);
    } else {
      const step = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageUp: [-20, 0], PageDown: [20, 0] }[e.key];
      if (!step) return;
      e.preventDefault();
      moveFocus(step[0]!, step[1]!, e.shiftKey);
    }
  };

  const virtualCols = cols.getVirtualItems();
  const totalWidth = cols.getTotalSize();

  return (
    <div
      ref={scroller}
      data-testid="result-grid"
      data-row-count={rowCount}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative min-h-0 flex-1 overflow-auto bg-results outline-none"
    >
      <div style={{ width: totalWidth, height: rows.getTotalSize(), position: "relative" }}>
        <div className="sticky top-0 z-20 border-b border-grid bg-results" style={{ height: HEADER_H, width: totalWidth }}>
          <div
            className="sticky left-0 z-10 flex h-full items-center justify-center border-r border-grid bg-results font-mono text-[12px] text-faint"
            style={{ width: rowNumW }}
          >
            #
          </div>
          {virtualCols.map((vc) => {
            const c = columns[vc.index]!;
            return (
              <div
                key={vc.key}
                data-testid={`grid-header-${vc.index}`}
                title={`${c.name} ${c.type.display}`}
                className="absolute top-0 flex h-full items-center gap-1 border-r border-grid px-1"
                style={{ left: vc.start, width: vc.size }}
              >
                {pk[vc.index] && <IconKeyFilled size={KEY_ICON} data-testid={`grid-pk-${vc.index}`} className="shrink-0 text-amber" />}
                <span className="max-w-full truncate text-[13px] font-medium text-fg">{c.name}</span>
              </div>
            );
          })}
        </div>

        {virtualRows.map((vr) => {
          const row = cache.get(vr.index);
          return (
            <div key={vr.key} className="absolute left-0 border-b border-grid" style={{ top: vr.start, height: ROW_H, width: totalWidth }}>
              <div
                className="sticky left-0 z-10 flex h-full items-center justify-center border-r border-grid bg-results font-mono text-[12px] text-faint tabular-nums"
                style={{ width: rowNumW }}
              >
                {vr.index + 1}
              </div>
              {virtualCols.map((vc) => {
                const c = columns[vc.index]!;
                const value = row?.[vc.index];
                const right = isRightAligned(c.type.category);
                const cut = cache.isCut(vr.index, vc.index);
                const selected = inSelection(selection, vr.index, vc.index);
                const focused = selection?.focus.row === vr.index && selection.focus.col === vc.index;
                return (
                  <div
                    key={vc.key}
                    data-testid={`grid-cell-${vr.index}-${vc.index}`}
                    onMouseDown={(e) => {
                      if (e.button !== 0) return;
                      dragging.current = true;
                      const cell = { row: vr.index, col: vc.index };
                      setSelection((sel) => ({ anchor: e.shiftKey && sel ? sel.anchor : cell, focus: cell }));
                    }}
                    onMouseEnter={() => {
                      if (dragging.current) setSelection((sel) => (sel ? { ...sel, focus: { row: vr.index, col: vc.index } } : sel));
                    }}
                    onDoubleClick={() => void openCell(vr.index, vc.index)}
                    className={cx(
                      "absolute top-0 flex h-full items-center gap-1 border-r border-grid px-1 font-mono text-[13px]",
                      right && "justify-end",
                      selected && "bg-cell-select",
                      focused && "outline outline-1 -outline-offset-1 outline-[#3a5f9e]",
                    )}
                    style={{ left: vc.start, width: vc.size }}
                  >
                    {value === undefined ? null : value === null ? (
                      <span className="text-faint">NULL</span>
                    ) : (
                      <>
                        <span className="min-w-0 truncate whitespace-pre text-fg">{right ? groupDigits(value) : value.replace(/\n/g, "↵ ")}</span>
                        {cut && (
                          <button
                            type="button"
                            data-testid={`grid-cut-${vr.index}-${vc.index}`}
                            title="Show the full value"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={() => void openCell(vr.index, vc.index)}
                            className="shrink-0 rounded bg-control px-1 font-sans text-[11px] leading-4 text-muted hover:text-fg"
                          >
                            …
                          </button>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

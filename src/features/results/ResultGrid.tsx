import {
  IconArrowNarrowDown,
  IconArrowNarrowUp,
  IconArrowsHorizontal,
  IconBinary,
  IconBox,
  IconBrackets,
  IconCalendar,
  IconCircleDot,
  IconFilter,
  IconFingerprint,
  IconHash,
  IconJson,
  IconKeyFilled,
  IconLetterCase,
  IconList,
  IconNetwork,
  IconToggleLeft,
  type Icon,
} from "@tabler/icons-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type Ref } from "react";
import type { ColumnMeta, Density, FontSetting, ResultMeta, TypeCategory } from "../../ipc/bindings";
import { DENSITY_FACTOR, gridRowHeight } from "../../shell/appearance";
import { rowCacheFor, type RowCache } from "../../state/rowCache";
import { isPrimaryKey, useCatalog } from "../../state/catalog";
import { NO_EDITS, markDeleted, removeNewRows, resetNewCell, rowKey, setCell, setNewCell, useTableEdits, type CellValue, type RowId, type TableEdits } from "../../state/tableEdits";
import { tabConnectionId, useWorkspace } from "../../state/workspace";
import { fontStack } from "../../themes/fonts";
import { ContextMenuArea, ContextMenuItem, cx } from "../../ui/primitives";
import { submitEdits } from "../editor/runActions";
import { groupDigits, isRightAligned, toTsv } from "./format";
import type { SortKey } from "./tableQuery";

const HEADER_H = 28;
const ROWNUM_W = 36;
const MIN_COL = 56;
const RESIZE_MIN = 40;
const CELL_PAD_X = 8;
const CELL_BORDER = 1;
const MAX_COL = 320;
const MONO_EM = 0.6;
const SANS_EM = 0.576;
const PREFETCH = 64;
const COPY_ROW_LIMIT = 50_000;

type Cell = { row: number; col: number };
type Selection = { anchor: Cell; focus: Cell } | null;

const HEADER_ICON = 12;
const HEADER_GAP = 6;
const SORT_BADGE_W = 20;
const FILTER_BUTTON_W = 20;
const QUERY_CONTROLS = SORT_BADGE_W + FILTER_BUTTON_W + 2 * HEADER_GAP;

export type GridEditing = { pkColumns: string[] };
export type GridActions = { addRow(): void; deleteSelectedRows(): void };

const DEFAULT = Symbol("default");

export type GridQuery = {
  sort: SortKey[];
  filtered: Set<string>;
  onSort(column: string, additive: boolean): void;
  onFilterColumn(column: string): void;
  onFilterValue(column: string, value: string | null, negate: boolean): void;
};

const TYPE_ICONS: Record<TypeCategory, Icon> = {
  Numeric: IconHash,
  Text: IconLetterCase,
  Bool: IconToggleLeft,
  Temporal: IconCalendar,
  Json: IconJson,
  Uuid: IconFingerprint,
  Binary: IconBinary,
  Network: IconNetwork,
  Array: IconBrackets,
  Enum: IconList,
  Composite: IconBox,
  Range: IconArrowsHorizontal,
  Other: IconCircleDot,
};

export function HeaderIcon({ column, primaryKey }: { column: ColumnMeta; primaryKey: boolean }) {
  if (primaryKey) return <IconKeyFilled size={HEADER_ICON} className="shrink-0 text-amber" />;
  const TypeIcon = TYPE_ICONS[column.type.category];
  return <TypeIcon size={HEADER_ICON} className="shrink-0 text-faint" />;
}

let measurer: CanvasRenderingContext2D | null | undefined;

function textWidth(text: string, size: number, family: string, weight: number, em: number): number {
  if (measurer === undefined) measurer = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!measurer) return text.length * size * em;
  measurer.font = `${weight} ${size}px ${family}`;
  return measurer.measureText(text).width;
}

type GridLook = { codeFont: FontSetting; interfaceFont: FontSetting; density: Density };

const codeCharWidth = ({ codeFont }: GridLook) => textWidth("0", codeFont.size, fontStack("code", codeFont.family), 400, MONO_EM);

// The header label is text-ui-12.5, medium weight.
const headerTextWidth = (name: string, { interfaceFont }: GridLook) =>
  textWidth(name, (12.5 * interfaceFont.size) / 13, fontStack("interface", interfaceFont.family), 500, SANS_EM);

function naturalWidths(columns: ColumnMeta[], cache: RowCache, sampleRows: number, headerExtra: number, look: GridLook): number[] {
  const charW = codeCharWidth(look);
  // The cell's px-2 padding follows the density's spacing scale.
  const chrome = 2 * CELL_PAD_X * DENSITY_FACTOR[look.density] + CELL_BORDER;
  return columns.map((c, i) => {
    let longest = 0;
    for (let r = 0; r < sampleRows; r++) {
      const v = cache.get(r)?.[i];
      const shown = v == null ? 4 : isRightAligned(c.type.category) ? groupDigits(v).length : Math.min(v.length, 60);
      longest = Math.max(longest, shown);
    }
    const header = headerTextWidth(c.name, look) + HEADER_ICON + 6 + headerExtra;
    const content = Math.max(header, longest * charW);
    return Math.min(MAX_COL, Math.max(MIN_COL, Math.ceil(content + chrome)));
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

const STEPS: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
  PageUp: [-20, 0],
  PageDown: [20, 0],
};

export function nextFocus(key: string, mod: boolean, from: Cell, rowCount: number, colCount: number): Cell | null {
  const lastRow = rowCount - 1;
  const lastCol = colCount - 1;
  if (key === "Home") return { row: mod ? 0 : from.row, col: 0 };
  if (key === "End") return { row: mod ? lastRow : from.row, col: lastCol };
  if (mod && key.startsWith("Arrow")) {
    const edges: Record<string, Cell> = {
      ArrowUp: { row: 0, col: from.col },
      ArrowDown: { row: lastRow, col: from.col },
      ArrowLeft: { row: from.row, col: 0 },
      ArrowRight: { row: from.row, col: lastCol },
    };
    return edges[key] ?? null;
  }
  const step = STEPS[key];
  if (!step) return null;
  const [dr, dc] = step;
  return {
    row: Math.max(0, Math.min(lastRow, from.row + dr)),
    col: Math.max(0, Math.min(lastCol, from.col + dc)),
  };
}

export function selectRows(anchorRow: number, focusRow: number, colCount: number): NonNullable<Selection> {
  const firstCol = 0;
  const lastCol = colCount - 1;
  return { anchor: { row: anchorRow, col: lastCol }, focus: { row: focusRow, col: firstCol } };
}

function fullRowRange(sel: Selection, colCount: number): [number, number] | null {
  if (!sel || Math.min(sel.anchor.col, sel.focus.col) !== 0 || Math.max(sel.anchor.col, sel.focus.col) !== colCount - 1) return null;
  return [Math.min(sel.anchor.row, sel.focus.row), Math.max(sel.anchor.row, sel.focus.row)];
}

function inSelection(sel: Selection, row: number, col: number): boolean {
  if (!sel) return false;
  const r0 = Math.min(sel.anchor.row, sel.focus.row);
  const r1 = Math.max(sel.anchor.row, sel.focus.row);
  const c0 = Math.min(sel.anchor.col, sel.focus.col);
  const c1 = Math.max(sel.anchor.col, sel.focus.col);
  return row >= r0 && row <= r1 && col >= c0 && col <= c1;
}

/** `pending(row, col)` is the value a pending edit or new row shows there, or undefined for the stored value. */
async function copySelection(
  cache: RowCache,
  sel: NonNullable<Selection>,
  rowCount: number,
  total: number,
  pending: (row: number, col: number) => CellValue | undefined,
) {
  const notify = useWorkspace.getState().notify;
  const r0 = Math.min(sel.anchor.row, sel.focus.row);
  const r1 = Math.min(Math.max(sel.anchor.row, sel.focus.row), total - 1);
  const c0 = Math.min(sel.anchor.col, sel.focus.col);
  const c1 = Math.max(sel.anchor.col, sel.focus.col);
  if (r1 - r0 + 1 > COPY_ROW_LIMIT) {
    notify(`Copy is limited to ${groupDigits(String(COPY_ROW_LIMIT))} rows. Use Export for the full result.`);
    return;
  }
  if (r0 < rowCount) await cache.ensure({ start: r0, end: Math.min(r1, rowCount - 1) + 1 }, rowCount);
  const rows: (string | null)[][] = [];
  for (let r = r0; r <= r1; r++) {
    const row = cache.get(r);
    const out: (string | null)[] = [];
    for (let c = c0; c <= c1; c++) {
      const shown = pending(r, c);
      if (shown !== undefined) out.push(shown);
      else if (r >= rowCount) out.push(null);
      else out.push(cache.isCut(r, c) ? ((await cache.loadFull(r, c)) ?? null) : (row?.[c] ?? null));
    }
    rows.push(out);
  }
  await navigator.clipboard.writeText(toTsv(rows));
  const cells = (r1 - r0 + 1) * (c1 - c0 + 1);
  if (cells > 1) notify(`Copied ${groupDigits(String(cells))} cells.`);
}

export function ResultGrid({
  meta,
  done,
  bottomInset,
  query,
  editing,
  actionsRef,
}: {
  meta: ResultMeta;
  done: boolean;
  bottomInset: number;
  query: GridQuery | null;
  editing: GridEditing | null;
  actionsRef?: Ref<GridActions | null>;
}) {
  const cache = rowCacheFor(meta.ref);
  useSyncExternalStore(cache.subscribe, cache.getVersion);
  const scroller = useRef<HTMLDivElement>(null);
  const viewport = useElementWidth(scroller);
  const [selection, setSelection] = useState<Selection>(null);
  const dragging = useRef<"cells" | "rows" | null>(null);
  const { rowCount, columns } = meta;
  const connectionId = useWorkspace((s) => tabConnectionId(s.tabs[meta.ref.tabId]));
  const catalog = useCatalog((s) => (connectionId ? s.views[connectionId] : undefined));
  const pk = useMemo(() => columns.map((c) => isPrimaryKey(catalog, c.source)), [columns, catalog]);
  const tabId = meta.ref.tabId;
  const pkIdx = useMemo(() => editing?.pkColumns.map((n) => columns.findIndex((c) => c.name === n)) ?? [], [editing, columns]);
  const editable = editing !== null && pkIdx.length > 0 && pkIdx.every((i) => i >= 0);
  const edits = useTableEdits((s) => (editable ? (s.byTab[tabId] ?? NO_EDITS) : NO_EDITS));
  const edit = (f: (e: TableEdits) => TableEdits) => useTableEdits.getState().edit(tabId, f);
  const total = rowCount + edits.inserts.length;
  const newRowAt = (row: number) => (row >= rowCount ? edits.inserts[row - rowCount] : undefined);
  const rowIdOf = (row: number): RowId | null => {
    const values = cache.get(row);
    if (!values || row >= rowCount) return null;
    const key = pkIdx.map((i) => values[i] ?? null);
    return { key: rowKey(key), values: key };
  };
  const cellValue = (row: number, col: number): CellValue | typeof DEFAULT | undefined => {
    const name = columns[col]!.name;
    const added = newRowAt(row);
    if (added) return name in added.values ? added.values[name]! : DEFAULT;
    const id = editable ? rowIdOf(row) : null;
    const changed = id ? edits.updates[id.key]?.values : undefined;
    return changed && name in changed ? changed[name]! : cache.get(row)?.[col];
  };
  const codeFont = useWorkspace((s) => s.settings.codeFont);
  const interfaceFont = useWorkspace((s) => s.settings.interfaceFont);
  const density = useWorkspace((s) => s.settings.density);
  const look = useMemo(() => ({ codeFont, interfaceFont, density }), [codeFont, interfaceFont, density]);
  const rowH = gridRowHeight(codeFont.size, density);
  const headerH = Math.round(HEADER_H * DENSITY_FACTOR[density]);
  const rowNumW = Math.max(ROWNUM_W, String(total).length * codeCharWidth(look) + 14);

  const [measured, setMeasured] = useState<{ look: GridLook; widths: number[] } | null>(null);
  const sampled = Math.min(rowCount, 64);
  const sampleReady = sampled > 0 ? cache.get(sampled - 1) !== undefined : done;
  useEffect(() => {
    if (measured?.look !== look && sampleReady) setMeasured({ look, widths: naturalWidths(columns, cache, sampled, query ? QUERY_CONTROLS : 0, look) });
  }, [measured, look, sampleReady, columns, cache, sampled, query]);
  const [resized, setResized] = useState<Record<number, number>>({});
  const widths = useMemo(() => columns.map((_, i) => resized[i] ?? measured?.widths[i] ?? MIN_COL), [columns, measured, resized]);

  const startResize = (e: React.MouseEvent, col: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[col]!;
    const move = (m: MouseEvent) => setResized((r) => ({ ...r, [col]: Math.max(RESIZE_MIN, Math.round(startW + m.clientX - startX)) }));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const resetWidth = (col: number) =>
    setResized((r) => {
      const { [col]: _, ...rest } = r;
      return rest;
    });

  const rows = useVirtualizer({
    count: total,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowH,
    paddingStart: headerH,
    scrollPaddingStart: headerH,
    paddingEnd: bottomInset,
    overscan: 12,
  });
  const cols = useVirtualizer({
    horizontal: true,
    count: columns.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => widths[i] ?? MIN_COL,
    paddingStart: rowNumW,
    scrollPaddingStart: rowNumW,
    overscan: 3,
  });
  useLayoutEffect(() => {
    cols.measure();
  }, [cols, widths, rowNumW]);
  useLayoutEffect(() => {
    rows.measure();
  }, [rows, rowH, headerH]);

  const virtualRows = rows.getVirtualItems();
  const firstRow = virtualRows[0]?.index ?? 0;
  const lastRow = virtualRows.at(-1)?.index ?? 0;
  useEffect(() => {
    void cache.ensure({ start: Math.max(0, firstRow - PREFETCH), end: lastRow + 1 + PREFETCH }, rowCount);
  }, [cache, firstRow, lastRow, rowCount]);

  useEffect(() => {
    const up = () => (dragging.current = null);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const openCell = async (row: number, col: number) => {
    const shown = cellValue(row, col);
    const value = row < rowCount && cache.isCut(row, col) ? await cache.loadFull(row, col) : shown === DEFAULT ? null : shown;
    if (value === undefined) return;
    useWorkspace.getState().open({ kind: "cell", title: `${columns[col]?.name ?? ""} · row ${row + 1}`, value });
  };

  const [editingCell, setEditingCell] = useState<(Cell & { draft: string; initial: string; stored: CellValue }) | null>(null);
  const opening = useRef(0);
  const refused = () => useWorkspace.getState().notify("A submit is running. Try again when it finishes.");
  const startEdit = (row: number, col: number, typed?: string) => {
    const id = rowIdOf(row);
    if (!editable || useTableEdits.getState().submitting[tabId] || (!newRowAt(row) && (!id || id.key in edits.deletes))) return;
    const name = columns[col]!.name;
    const pending = newRowAt(row) || (id && name in (edits.updates[id.key]?.values ?? {}));
    const open = (initial: string, stored: CellValue) =>
      setEditingCell((cur) =>
        typed !== undefined && cur?.row === row && cur.col === col
          ? { ...cur, draft: cur.draft + typed }
          : { row, col, initial, stored, draft: typed ?? initial },
      );
    const seq = ++opening.current;
    // The page cache cuts long values. Typing replaces the value, so only opening a cut cell as-is waits for its full text.
    if (pending || typed !== undefined || !cache.isCut(row, col)) {
      const shown = cellValue(row, col);
      return open(typeof shown === "string" ? shown : "", row < rowCount ? (cache.get(row)?.[col] ?? null) : null);
    }
    void cache.loadFull(row, col).then((full) => {
      if (opening.current === seq) open(full ?? "", full ?? null);
    });
  };
  const writeCell = (row: number, col: number, value: CellValue | typeof DEFAULT, stored = cache.get(row)?.[col] ?? null) => {
    const name = columns[col]!.name;
    const added = newRowAt(row);
    if (added) {
      if (!edit((e) => (value === DEFAULT ? resetNewCell(e, added.id, name) : setNewCell(e, added.id, name, value)))) refused();
      return;
    }
    const id = rowIdOf(row);
    if (id && value !== DEFAULT && !edit((e) => setCell(e, id, name, value, stored))) refused();
  };
  const finishEdit = (save: boolean) => {
    if (editingCell && save && editingCell.draft !== editingCell.initial) writeCell(editingCell.row, editingCell.col, editingCell.draft, editingCell.stored);
    setEditingCell(null);
    scroller.current?.focus();
  };
  const selectedRows = () => {
    if (!selection) return [];
    const r0 = Math.min(selection.anchor.row, selection.focus.row);
    const r1 = Math.max(selection.anchor.row, selection.focus.row);
    return Array.from({ length: r1 - r0 + 1 }, (_, i) => r0 + i);
  };
  const deleting = useRef(false);
  const deleteSelectedRows = async () => {
    if (deleting.current) return;
    const picked = selectedRows();
    const storedRows = picked.filter((r) => r < rowCount);
    deleting.current = true;
    try {
      if (storedRows.length) await cache.ensure({ start: storedRows[0]!, end: storedRows.at(-1)! + 1 }, rowCount);
    } finally {
      deleting.current = false;
    }
    const added = picked.flatMap((r) => newRowAt(r)?.id ?? []);
    const stored = storedRows.flatMap((r) => rowIdOf(r) ?? []);
    const marked = useTableEdits.getState().byTab[tabId]?.deletes ?? {};
    const restore = stored.length > 0 && stored.every((r) => r.key in marked);
    if (!edit((e) => markDeleted(removeNewRows(e, added), stored, !restore))) refused();
  };
  const insertsSeen = useRef(edits.inserts.length);
  useEffect(() => {
    if (edits.inserts.length > insertsSeen.current) {
      const row = rowCount + edits.inserts.length - 1;
      const col = Math.max(0, columns.findIndex((_, i) => !pkIdx.includes(i)));
      rows.scrollToIndex(row);
      setSelection({ anchor: { row, col }, focus: { row, col } });
      scroller.current?.focus();
    }
    insertsSeen.current = edits.inserts.length;
  }, [edits.inserts.length, rowCount, columns, pkIdx, rows]);
  useImperativeHandle(actionsRef, () => ({ addRow: () => void useTableEdits.getState().addRow(tabId), deleteSelectedRows: () => void deleteSelectedRows() }));


  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (editable && mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void submitEdits(tabId);
    } else if (editable && mod && e.key === "Backspace" && selection) {
      e.preventDefault();
      if (!e.repeat) void deleteSelectedRows();
    } else if (editable && selection && (e.key === "Enter" || e.key === "F2")) {
      e.preventDefault();
      startEdit(selection.focus.row, selection.focus.col);
    } else if (editable && selection && e.key.length === 1 && !mod && !e.altKey) {
      e.preventDefault();
      startEdit(selection.focus.row, selection.focus.col, e.key);
    } else if (mod && e.key.toLowerCase() === "c" && selection) {
      e.preventDefault();
      void copySelection(cache, selection, rowCount, total, (r, c) => {
        const shown = cellValue(r, c);
        if (shown === DEFAULT) return null;
        return newRowAt(r) || (editable && edits.updates[rowIdOf(r)?.key ?? ""]?.values[columns[c]!.name] !== undefined) ? shown : undefined;
      });
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelection({ anchor: { row: 0, col: 0 }, focus: { row: total - 1, col: columns.length - 1 } });
    } else if (e.key === "Enter" && selection) {
      void openCell(selection.focus.row, selection.focus.col);
    } else {
      const focus = nextFocus(e.key, mod, selection?.focus ?? { row: 0, col: 0 }, total, columns.length);
      if (!focus) return;
      e.preventDefault();
      rows.scrollToIndex(focus.row);
      cols.scrollToIndex(focus.col);
      setSelection((sel) => ({ anchor: e.shiftKey && sel ? sel.anchor : focus, focus }));
    }
  };

  const virtualCols = cols.getVirtualItems();
  const totalWidth = Math.max(cols.getTotalSize(), viewport);
  const focus = selection?.focus;
  const fullRows = fullRowRange(selection, columns.length);
  const [menuCell, setMenuCell] = useState<Cell | null>(null);
  const menuColumn = menuCell ? columns[menuCell.col]?.name : undefined;
  const menuValue = menuCell && menuCell.row < rowCount ? cache.get(menuCell.row)?.[menuCell.col] : undefined;
  const menuRowDeleted = menuCell ? (rowIdOf(menuCell.row)?.key ?? "") in edits.deletes : false;
  const shortValue = (v: string) => (v.length > 24 ? `${v.slice(0, 24)}…` : v);

  const grid = (
    <div
      ref={scroller}
      data-testid="result-grid"
      data-row-count={rowCount}
      data-pending={editable ? edits.inserts.length + Object.keys(edits.updates).length + Object.keys(edits.deletes).length : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        if (!(e.target as Element).closest("[data-testid^='grid-cell-']")) e.preventDefault();
      }}
      className="relative min-h-0 flex-1 overflow-auto bg-results outline-none"
    >
      <div style={{ width: totalWidth, height: rows.getTotalSize(), position: "relative" }}>
        <div className="sticky top-0 z-20 border-b border-grid bg-results" style={{ height: headerH, width: totalWidth }}>
          <div
            className="sticky left-0 z-10 flex h-full items-center justify-center border-r border-grid bg-results font-mono text-code-sm text-faint"
            style={{ width: rowNumW }}
          >
            #
          </div>
          {virtualCols.map((vc) => {
            const c = columns[vc.index]!;
            const sortAt = query ? query.sort.findIndex((k) => k.column === c.name) : -1;
            const sortKey = query?.sort[sortAt];
            const filtered = query?.filtered.has(c.name) ?? false;
            return (
              <div
                key={vc.key}
                data-testid={`grid-header-${vc.index}`}
                title={query ? `${c.name} ${c.type.display}\nClick to sort, Shift-click to add to the sort` : `${c.name} ${c.type.display}`}
                onClick={query ? (e) => query.onSort(c.name, e.shiftKey) : undefined}
                className={cx(
                  "group/header absolute top-0 flex h-full items-center gap-1.5 border-r border-grid px-2",
                  focus?.col === vc.index ? "bg-hover text-fg" : "text-muted",
                  query && "cursor-pointer hover:bg-hover hover:text-fg",
                )}
                style={{ left: vc.start, width: vc.size }}
              >
                <HeaderIcon column={c} primaryKey={pk[vc.index]!} />
                <span className="min-w-0 truncate text-ui-12.5 font-medium">{c.name}</span>
                {sortKey && (
                  <span data-testid={`grid-sort-${vc.index}`} className="flex shrink-0 items-center text-keyword">
                    {sortKey.desc ? <IconArrowNarrowDown size={13} /> : <IconArrowNarrowUp size={13} />}
                    {query!.sort.length > 1 && <span className="font-mono text-ui-10">{sortAt + 1}</span>}
                  </span>
                )}
                {query && (
                  <button
                    type="button"
                    data-testid={`grid-filter-${vc.index}`}
                    aria-label={`Filter ${c.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      query.onFilterColumn(c.name);
                    }}
                    className={cx(
                      "ml-auto grid size-5 shrink-0 place-items-center rounded hover:bg-control",
                      filtered ? "text-keyword" : "text-dim opacity-0 group-hover/header:opacity-100",
                    )}
                  >
                    <IconFilter size={12} />
                  </button>
                )}
                <div
                  data-testid={`grid-resize-${vc.index}`}
                  title="Drag to resize, double-click to reset"
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => startResize(e, vc.index)}
                  onDoubleClick={() => resetWidth(vc.index)}
                  className="absolute top-0 -right-[3px] z-10 h-full w-[5px] cursor-col-resize hover:bg-focus"
                />
              </div>
            );
          })}
        </div>

        {virtualRows.map((vr) => {
          const added = newRowAt(vr.index);
          const id = editable && !added ? rowIdOf(vr.index) : null;
          const deleted = id ? id.key in edits.deletes : false;
          const changed = id ? edits.updates[id.key]?.values : undefined;
          const failed = edits.failedAt && ("insert" in edits.failedAt ? added?.id === edits.failedAt.insert : id?.key === edits.failedAt.key);
          return (
            <div
              key={vr.key}
              data-testid={`grid-row-${vr.index}`}
              data-state={added ? "new" : deleted ? "deleted" : changed ? "changed" : undefined}
              className={cx(
                "group absolute left-0 border-b border-grid",
                added ? "bg-green/10" : deleted ? "bg-danger/10" : "hover:bg-hover",
                failed && "outline outline-1 -outline-offset-1 outline-danger",
              )}
              style={{ top: vr.start, height: rowH, width: totalWidth }}
            >
              <div
                data-testid={`grid-rownum-${vr.index}`}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  dragging.current = "rows";
                  setSelection((sel) => selectRows(e.shiftKey && sel ? sel.anchor.row : vr.index, vr.index, columns.length));
                }}
                onMouseEnter={() => {
                  if (dragging.current === "rows") setSelection((sel) => (sel ? selectRows(sel.anchor.row, vr.index, columns.length) : sel));
                }}
                className={cx(
                  "sticky left-0 z-10 flex h-full items-center justify-center border-r border-grid font-mono text-code-sm tabular-nums",
                  fullRows && vr.index >= fullRows[0] && vr.index <= fullRows[1]
                    ? "bg-cell-select text-fg"
                    : focus?.row === vr.index
                      ? "bg-hover text-fg"
                      : "bg-results text-faint group-hover:bg-hover",
                )}
                style={{ width: rowNumW }}
              >
                {added ? <span className="text-green">+</span> : vr.index + 1}
              </div>
              {virtualCols.map((vc) => {
                const c = columns[vc.index]!;
                const value = cellValue(vr.index, vc.index);
                const right = isRightAligned(c.type.category);
                const cut = !added && !(changed && c.name in changed) && cache.isCut(vr.index, vc.index);
                const isEditing = editingCell?.row === vr.index && editingCell.col === vc.index;
                const selected = inSelection(selection, vr.index, vc.index);
                const focused = focus?.row === vr.index && focus.col === vc.index;
                return (
                  <div
                    key={vc.key}
                    data-testid={`grid-cell-${vr.index}-${vc.index}`}
                    onMouseDown={(e) => {
                      if (e.button !== 0) return;
                      dragging.current = "cells";
                      const cell = { row: vr.index, col: vc.index };
                      setSelection((sel) => ({ anchor: e.shiftKey && sel ? sel.anchor : cell, focus: cell }));
                    }}
                    onMouseEnter={() => {
                      if (dragging.current === "cells") setSelection((sel) => (sel ? { ...sel, focus: { row: vr.index, col: vc.index } } : sel));
                      if (dragging.current === "rows") setSelection((sel) => (sel ? selectRows(sel.anchor.row, vr.index, columns.length) : sel));
                    }}
                    onDoubleClick={() => (editable ? startEdit(vr.index, vc.index) : void openCell(vr.index, vc.index))}
                    onContextMenu={() => {
                      const cell = { row: vr.index, col: vc.index };
                      setMenuCell(cell);
                      if (!inSelection(selection, cell.row, cell.col)) setSelection({ anchor: cell, focus: cell });
                    }}
                    className={cx(
                      "absolute top-0 flex h-full items-center gap-1 border-r border-grid px-2 font-mono text-code",
                      right && "justify-end",
                      changed && c.name in changed && "bg-amber/15",
                      selected && "bg-cell-select",
                      deleted && "text-faint line-through",
                      focused && "outline outline-1 -outline-offset-1 outline-focus",
                    )}
                    style={{ left: vc.start, width: vc.size }}
                  >
                    {isEditing ? (
                      <input
                        data-testid="grid-editor"
                        autoFocus
                        value={editingCell.draft}
                        spellCheck={false}
                        onMouseDown={(e) => e.stopPropagation()}
                        onChange={(e) => setEditingCell({ ...editingCell, draft: e.target.value })}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") finishEdit(true);
                          if (e.key === "Escape") finishEdit(false);
                          if (e.key === "Tab") {
                            e.preventDefault();
                            finishEdit(true);
                            const next = { row: vr.index, col: Math.max(0, Math.min(columns.length - 1, vc.index + (e.shiftKey ? -1 : 1))) };
                            setSelection({ anchor: next, focus: next });
                            cols.scrollToIndex(next.col);
                          }
                        }}
                        onBlur={() => finishEdit(true)}
                        className="absolute inset-0 z-10 bg-bg px-2 font-mono text-code text-fg outline outline-1 -outline-offset-1 outline-focus"
                      />
                    ) : value === DEFAULT ? (
                      <span className="text-faint italic">DEFAULT</span>
                    ) : value === undefined ? null : value === null ? (
                      <span className="text-faint">NULL</span>
                    ) : (
                      <>
                        <span className={cx("min-w-0 truncate whitespace-pre", !deleted && "text-fg")}>{right ? groupDigits(value) : value.replace(/\n/g, "↵ ")}</span>
                        {cut && (
                          <button
                            type="button"
                            data-testid={`grid-cut-${vr.index}-${vc.index}`}
                            title="Show the full value"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={() => void openCell(vr.index, vc.index)}
                            className="shrink-0 rounded bg-control px-1 font-sans text-ui-11 leading-4 text-muted hover:text-fg"
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
  if (!query) return grid;
  return (
    <ContextMenuArea
      menu={
        menuCell &&
        menuColumn !== undefined && (
          <>
            {menuValue !== undefined && (
              <>
                <ContextMenuItem testId="grid-menu-filter-eq" onSelect={() => query.onFilterValue(menuColumn, menuValue, false)}>
                  {menuValue === null ? `Filter ${menuColumn} is null` : `Filter ${menuColumn} = ${shortValue(menuValue)}`}
                </ContextMenuItem>
                <ContextMenuItem testId="grid-menu-filter-ne" onSelect={() => query.onFilterValue(menuColumn, menuValue, true)}>
                  {menuValue === null ? `Filter ${menuColumn} is not null` : `Filter ${menuColumn} ≠ ${shortValue(menuValue)}`}
                </ContextMenuItem>
              </>
            )}
            <ContextMenuItem testId="grid-menu-filter-column" onSelect={() => query.onFilterColumn(menuColumn)}>
              Filter {menuColumn}…
            </ContextMenuItem>
            {editable && (
              <>
                <div className="my-1 h-px bg-control" />
                {!menuRowDeleted && (
                  <>
                    <ContextMenuItem testId="grid-menu-edit" onSelect={() => startEdit(menuCell.row, menuCell.col)}>
                      Edit cell
                    </ContextMenuItem>
                    <ContextMenuItem testId="grid-menu-null" onSelect={() => writeCell(menuCell.row, menuCell.col, null)}>
                      Set NULL
                    </ContextMenuItem>
                    {newRowAt(menuCell.row) && (
                      <ContextMenuItem testId="grid-menu-default" onSelect={() => writeCell(menuCell.row, menuCell.col, DEFAULT)}>
                        Set DEFAULT
                      </ContextMenuItem>
                    )}
                  </>
                )}
                <ContextMenuItem testId="grid-menu-delete" onSelect={deleteSelectedRows}>
                  {menuRowDeleted ? "Restore row" : "Delete row"}
                </ContextMenuItem>
                <ContextMenuItem testId="grid-menu-add" onSelect={() => useTableEdits.getState().addRow(tabId)}>
                  Add row
                </ContextMenuItem>
              </>
            )}
          </>
        )
      }
    >
      {grid}
    </ContextMenuArea>
  );
}

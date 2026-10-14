import { create } from "zustand";
import type { CellWrite, ChangeRef, TabId, TableChanges } from "../ipc/bindings";

export type CellValue = string | null;
export type RowKey = string;
export type RowId = { key: RowKey; values: CellValue[] };

export type NewRow = { id: number; values: Record<string, CellValue> };

export type TableEdits = {
  inserts: NewRow[];
  updates: Record<RowKey, { key: CellValue[]; values: Record<string, CellValue> }>;
  deletes: Record<RowKey, CellValue[]>;
  failedAt: { insert: number } | { key: RowKey } | null;
};

export const NO_EDITS: TableEdits = { inserts: [], updates: {}, deletes: {}, failedAt: null };

export const rowKey = (values: CellValue[]): RowKey => JSON.stringify(values);

export function pendingCount(e: TableEdits): number {
  return e.inserts.length + Object.keys(e.updates).filter((k) => !(k in e.deletes)).length + Object.keys(e.deletes).length;
}

export function addRow(e: TableEdits, id: number): TableEdits {
  return { ...e, inserts: [...e.inserts, { id, values: {} }] };
}

export function setNewCell(e: TableEdits, id: number, column: string, value: CellValue): TableEdits {
  return { ...e, inserts: e.inserts.map((r) => (r.id === id ? { ...r, values: { ...r.values, [column]: value } } : r)) };
}

export function resetNewCell(e: TableEdits, id: number, column: string): TableEdits {
  return {
    ...e,
    inserts: e.inserts.map((r) => {
      if (r.id !== id) return r;
      const { [column]: _, ...rest } = r.values;
      return { ...r, values: rest };
    }),
  };
}

export function removeNewRows(e: TableEdits, ids: number[]): TableEdits {
  return { ...e, inserts: e.inserts.filter((r) => !ids.includes(r.id)) };
}

export function setCell(e: TableEdits, row: RowId, column: string, value: CellValue, stored: CellValue): TableEdits {
  const current = e.updates[row.key]?.values ?? {};
  const { [column]: _, ...rest } = current;
  const values = value === stored ? rest : { ...rest, [column]: value };
  const { [row.key]: __, ...others } = e.updates;
  return { ...e, updates: Object.keys(values).length ? { ...others, [row.key]: { key: row.values, values } } : others };
}

export function toggleDeletes(e: TableEdits, rows: RowId[]): TableEdits {
  const deletes = { ...e.deletes };
  const allMarked = rows.every((r) => r.key in deletes);
  for (const r of rows) {
    if (allMarked) delete deletes[r.key];
    else deletes[r.key] = r.values;
  }
  return { ...e, deletes };
}

const writes = (columns: string[], values: CellValue[]): CellWrite[] => columns.map((column, i) => ({ column, value: values[i] ?? null }));
const entries = (values: Record<string, CellValue>): CellWrite[] => Object.entries(values).map(([column, value]) => ({ column, value }));

export function toChanges(
  e: TableEdits,
  schema: string,
  table: string,
  pkColumns: string[],
): { changes: TableChanges; rowOf: (ref: ChangeRef) => TableEdits["failedAt"] } {
  const deleteKeys = Object.keys(e.deletes);
  const updateKeys = Object.keys(e.updates).filter((k) => !(k in e.deletes));
  const changes: TableChanges = {
    schema,
    table,
    inserts: e.inserts.map((r) => entries(r.values)),
    updates: updateKeys.map((k) => ({ key: writes(pkColumns, e.updates[k]!.key), set: entries(e.updates[k]!.values) })),
    deletes: deleteKeys.map((k) => writes(pkColumns, e.deletes[k]!)),
  };
  const rowOf = (ref: ChangeRef): TableEdits["failedAt"] => {
    if (ref.kind === "Insert") return { insert: e.inserts[ref.index]!.id };
    return { key: (ref.kind === "Update" ? updateKeys : deleteKeys)[ref.index]! };
  };
  return { changes, rowOf };
}

let nextRowId = 1;

export const useTableEdits = create<{
  byTab: Record<TabId, TableEdits>;
  edit(tab: TabId, f: (e: TableEdits) => TableEdits): void;
  addRow(tab: TabId): number;
  clear(tab: TabId): void;
}>((set) => ({
  byTab: {},
  edit: (tab, f) => set((s) => ({ byTab: { ...s.byTab, [tab]: { ...f(s.byTab[tab] ?? NO_EDITS), failedAt: null } } })),
  addRow: (tab) => {
    const id = nextRowId++;
    set((s) => ({ byTab: { ...s.byTab, [tab]: addRow(s.byTab[tab] ?? NO_EDITS, id) } }));
    return id;
  },
  clear: (tab) =>
    set((s) => {
      const { [tab]: _, ...rest } = s.byTab;
      return { byTab: rest };
    }),
}));

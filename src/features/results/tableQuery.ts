import { create } from "zustand";
import type { ColumnFilter, FilterOp, TabId } from "../../ipc/bindings";
import { sqlIdent } from "../editor/sqlIdent";

export type SortKey = { column: string; desc: boolean };

export const FILTER_OPS: readonly { op: FilterOp; label: string; takesValue: boolean }[] = [
  { op: "Eq", label: "=", takesValue: true },
  { op: "Ne", label: "≠", takesValue: true },
  { op: "Lt", label: "<", takesValue: true },
  { op: "Le", label: "≤", takesValue: true },
  { op: "Gt", label: ">", takesValue: true },
  { op: "Ge", label: "≥", takesValue: true },
  { op: "Contains", label: "contains", takesValue: true },
  { op: "StartsWith", label: "starts with", takesValue: true },
  { op: "IsNull", label: "is null", takesValue: false },
  { op: "NotNull", label: "is not null", takesValue: false },
];

export const takesValue = (op: FilterOp) => FILTER_OPS.find((o) => o.op === op)?.takesValue ?? true;

export function nextSort(sort: SortKey[], column: string, additive: boolean): SortKey[] {
  const current = sort.find((k) => k.column === column);
  const cycle = (k: SortKey | undefined): SortKey | null => (!k ? { column, desc: false } : k.desc ? null : { column, desc: true });
  const next = cycle(current);
  if (!additive) return next ? [next] : [];
  if (!current) return [...sort, next!];
  return sort.flatMap((k) => (k.column !== column ? [k] : next ? [next] : []));
}

const ORDER_KEY = /^\s*("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s+(ASC|DESC))?\s*(,|$)/i;

export function parseOrderBy(text: string): SortKey[] | null {
  const keys: SortKey[] = [];
  let rest = text.trim();
  while (rest) {
    const m = ORDER_KEY.exec(rest);
    if (!m) return null;
    const ident = m[1]!;
    const column = ident.startsWith('"') ? ident.slice(1, -1).replaceAll('""', '"') : ident.toLowerCase();
    keys.push({ column, desc: m[2]?.toUpperCase() === "DESC" });
    rest = rest.slice(m[0].length).trim();
    if (m[3] === "," && !rest) return null;
  }
  return keys;
}

export function formatOrderBy(keys: SortKey[]): string {
  return keys.map((k) => `${sqlIdent(k.column)}${k.desc ? " DESC" : ""}`).join(", ");
}

export function filterForValue(column: string, value: string | null, negate: boolean): ColumnFilter {
  if (value === null) return { column, op: negate ? "NotNull" : "IsNull", value: "" };
  return { column, op: negate ? "Ne" : "Eq", value };
}

export type FilterDraft = ColumnFilter & { id: number };

let nextDraftId = 1;

export const useFilterDrafts = create<{
  drafts: Record<TabId, FilterDraft[]>;
  add(tab: TabId, column: string): void;
  remove(tab: TabId, id: number): void;
}>((set) => ({
  drafts: {},
  add: (tab, column) =>
    set((s) => ({ drafts: { ...s.drafts, [tab]: [...(s.drafts[tab] ?? []), { id: nextDraftId++, column, op: "Eq", value: "" }] } })),
  remove: (tab, id) => set((s) => ({ drafts: { ...s.drafts, [tab]: (s.drafts[tab] ?? []).filter((d) => d.id !== id) } })),
}));

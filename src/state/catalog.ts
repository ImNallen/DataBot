import type { Completion } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import { create } from "zustand";
import { sqlIdent } from "../features/editor/sqlIdent";
import { shortType } from "../features/results/format";
import { commands, type Catalog, type ColumnSource, type DatabaseRef, type RelKind, type Relation } from "../ipc/bindings";
import { dbKey, type DbKey } from "./dbKey";

export type SearchItem =
  | { kind: "table" | "view"; label: string; db: DatabaseRef; schema: string; relation: string; detail: string }
  | { kind: "column"; label: string; db: DatabaseRef; schema: string; relation: string; column: string; detail: string }
  | { kind: "function"; label: string; db: DatabaseRef; schema: string; name: string; detail: string };

export type CatalogView = {
  catalog: Catalog;
  completion: SQLNamespace;
  qualifiedTables: Completion[];
  searchItems: SearchItem[];
  relationsById: Map<number, { schema: string; rel: Relation }>;
};

export function isViewKind(kind: RelKind): boolean {
  return kind === "View" || kind === "MaterializedView";
}

export function buildCatalogView(catalog: Catalog): CatalogView {
  const completion: Record<string, SQLNamespace> = {};
  const qualifiedTables: Completion[] = [];
  const relationsById = new Map<number, { schema: string; rel: Relation }>();
  const relations: SearchItem[] = [];
  const views: SearchItem[] = [];
  const functions: SearchItem[] = [];
  const columns: SearchItem[] = [];
  const db = catalog.db;

  for (const schema of catalog.schemas) {
    const tables: Record<string, SQLNamespace> = {};
    for (const rel of schema.relations) {
      relationsById.set(rel.oid, { schema: schema.name, rel });
      const view = isViewKind(rel.kind);
      tables[rel.name] = {
        self: { label: rel.name, type: view ? "type" : "class", detail: view ? "view" : "table" },
        children: rel.columns.map((c): Completion => ({ label: c.name, type: "property", detail: shortType(c.typeDisplay) })),
      };
      qualifiedTables.push({
        label: `${schema.name}.${rel.name}`,
        apply: `${sqlIdent(schema.name)}.${sqlIdent(rel.name)}`,
        type: view ? "type" : "class",
        detail: view ? "view" : "table",
      });
      (view ? views : relations).push({
        kind: view ? "view" : "table",
        label: rel.name,
        db,
        schema: schema.name,
        relation: rel.name,
        detail: schema.name,
      });
      for (const c of rel.columns) {
        columns.push({
          kind: "column",
          label: `${rel.name}.${c.name}`,
          db,
          schema: schema.name,
          relation: rel.name,
          column: c.name,
          detail: shortType(c.typeDisplay),
        });
      }
    }
    for (const fn of schema.functions) {
      functions.push({
        kind: "function",
        label: fn.name,
        db,
        schema: schema.name,
        name: fn.name,
        detail: `(${fn.args}) → ${fn.returns}`,
      });
    }
    completion[schema.name] = tables;
  }

  return { catalog, completion, qualifiedTables, searchItems: [...relations, ...views, ...functions, ...columns], relationsById };
}

export function isPrimaryKey(view: CatalogView | undefined, source: ColumnSource | null): boolean {
  if (!view || !source) return false;
  return view.relationsById.get(source.tableOid)?.rel.columns.find((c) => c.attnum === source.attnum)?.pk ?? false;
}

type CatalogStore = {
  views: Record<DbKey, CatalogView>;
  /** Fetches `catalog_get(ref)` when the held version is older. One fetch per key at a time. */
  ensure(ref: DatabaseRef, version: number): Promise<void>;
  /** Drops every view not in `keep`: a disconnect, a hidden database, or a dropped one. */
  prune(keep: ReadonlySet<DbKey>): void;
};

const inflight = new Map<DbKey, number>();

export const useCatalog = create<CatalogStore>()((set, get) => ({
  views: {},
  async ensure(ref, version) {
    const key = dbKey(ref);
    const loaded = get().views[key]?.catalog.version ?? -1;
    if (loaded >= version || (inflight.get(key) ?? -1) >= version) return;
    inflight.set(key, version);
    try {
      const res = await commands.catalogGet(ref);
      // A prune while the fetch was out means the catalog is no longer wanted.
      if (res.status === "error" || inflight.get(key) !== version) return;
      const current = get().views[key]?.catalog.version ?? -1;
      if (res.data.version > current) set((s) => ({ views: { ...s.views, [key]: buildCatalogView(res.data) } }));
    } finally {
      if (inflight.get(key) === version) inflight.delete(key);
    }
  },
  prune(keep) {
    for (const key of [...inflight.keys()]) if (!keep.has(key)) inflight.delete(key);
    set((s) => {
      const kept = Object.entries(s.views).filter(([key]) => keep.has(key as DbKey));
      return kept.length === Object.keys(s.views).length ? {} : { views: Object.fromEntries(kept) };
    });
  },
}));

export function viewFor(views: Record<DbKey, CatalogView>, ref: DatabaseRef | null | undefined): CatalogView | undefined {
  return ref ? views[dbKey(ref)] : undefined;
}

export function findRelation(view: CatalogView | undefined, schema: string, name: string): Relation | undefined {
  return view?.catalog.schemas.find((s) => s.name === schema)?.relations.find((r) => r.name === name);
}

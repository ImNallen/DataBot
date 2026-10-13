import type { Completion } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import { create } from "zustand";
import { commands, type Catalog, type ConnectionId, type RelKind, type Relation } from "../ipc/bindings";

export type SearchItem =
  | { kind: "table" | "view"; label: string; connectionId: ConnectionId; schema: string; relation: string; detail: string }
  | { kind: "column"; label: string; connectionId: ConnectionId; schema: string; relation: string; column: string; detail: string }
  | { kind: "function"; label: string; connectionId: ConnectionId; schema: string; name: string; detail: string };

export type CatalogView = {
  catalog: Catalog;
  completion: SQLNamespace;
  searchItems: SearchItem[];
  relationsById: Map<number, { schema: string; rel: Relation }>;
};

export function isViewKind(kind: RelKind): boolean {
  return kind === "View" || kind === "MaterializedView";
}

/** Pure derivation of everything the tree, ⌘P, and completion need from one snapshot. */
export function buildCatalogView(catalog: Catalog): CatalogView {
  const completion: Record<string, SQLNamespace> = {};
  const relationsById = new Map<number, { schema: string; rel: Relation }>();
  const relations: SearchItem[] = [];
  const views: SearchItem[] = [];
  const functions: SearchItem[] = [];
  const columns: SearchItem[] = [];
  const connectionId = catalog.connectionId;

  for (const schema of catalog.schemas) {
    const tables: Record<string, SQLNamespace> = {};
    for (const rel of schema.relations) {
      relationsById.set(rel.oid, { schema: schema.name, rel });
      const view = isViewKind(rel.kind);
      tables[rel.name] = {
        self: { label: rel.name, type: view ? "type" : "class", detail: view ? "view" : "table" },
        children: rel.columns.map((c): Completion => ({ label: c.name, type: "property", detail: c.typeDisplay })),
      };
      (view ? views : relations).push({
        kind: view ? "view" : "table",
        label: rel.name,
        connectionId,
        schema: schema.name,
        relation: rel.name,
        detail: schema.name,
      });
      for (const c of rel.columns) {
        columns.push({
          kind: "column",
          label: `${rel.name}.${c.name}`,
          connectionId,
          schema: schema.name,
          relation: rel.name,
          column: c.name,
          detail: c.typeDisplay,
        });
      }
    }
    for (const fn of schema.functions) {
      functions.push({
        kind: "function",
        label: fn.name,
        connectionId,
        schema: schema.name,
        name: fn.name,
        detail: `(${fn.args}) → ${fn.returns}`,
      });
    }
    completion[schema.name] = tables;
  }

  return { catalog, completion, searchItems: [...relations, ...views, ...functions, ...columns], relationsById };
}

type CatalogStore = {
  views: Record<ConnectionId, CatalogView>;
  /** Fetches the snapshot unless the loaded one is already at `version` or newer. */
  ensure(id: ConnectionId, version: number): Promise<void>;
};

const inflight = new Map<ConnectionId, number>();

export const useCatalog = create<CatalogStore>()((set, get) => ({
  views: {},
  async ensure(id, version) {
    const loaded = get().views[id]?.catalog.version ?? -1;
    if (loaded >= version || (inflight.get(id) ?? -1) >= version) return;
    inflight.set(id, version);
    try {
      const res = await commands.catalogGet(id);
      if (res.status === "error") return;
      const current = get().views[id]?.catalog.version ?? -1;
      if (res.data.version > current) set((s) => ({ views: { ...s.views, [id]: buildCatalogView(res.data) } }));
    } finally {
      if (inflight.get(id) === version) inflight.delete(id);
    }
  },
}));

export function findRelation(view: CatalogView | undefined, schema: string, name: string): Relation | undefined {
  return view?.catalog.schemas.find((s) => s.name === schema)?.relations.find((r) => r.name === name);
}

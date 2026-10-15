import type { ColumnInfo, ConnectionConfig, ConnectionId, ConnectionState, DatabaseRef, FunctionInfo, Relation } from "../../ipc/bindings";
import { isViewKind, viewFor, type CatalogView } from "../../state/catalog";
import type { DbKey } from "../../state/dbKey";
import { instanceOf } from "../../state/live";
import type { RelationRef } from "../../state/workspace";
import { matchRanges, type TextRange } from "../../ui/textMatch";

export type FilteredColumn = { column: ColumnInfo; ranges: TextRange[] };
/** `ranges` is null when the relation shows only as the parent of a matching column. */
export type FilteredRelation = { rel: Relation; ranges: TextRange[] | null; columns: FilteredColumn[] };
export type FilteredFunction = { fn: FunctionInfo; ranges: TextRange[] };
export type FilteredSchema = { name: string; relations: FilteredRelation[]; functions: FilteredFunction[] };
export type FilteredDatabase = { db: DatabaseRef; schemas: FilteredSchema[] };
export type FilteredConnection = { config: ConnectionConfig; databases: FilteredDatabase[] };
/** `count` is the matched objects. `searched` is how many catalogs the filter could search. */
export type TreeFilter = { connections: FilteredConnection[]; count: number; searched: number };

function filterRelation(tokens: readonly string[], rel: Relation): FilteredRelation | null {
  const ranges = matchRanges(tokens, rel.name);
  const columns = rel.columns.flatMap((column) => {
    const r = matchRanges(tokens, column.name);
    return r ? [{ column, ranges: r }] : [];
  });
  return ranges || columns.length > 0 ? { rel, ranges, columns } : null;
}

/**
 * The tree's working set narrowed to the objects whose own name holds every token: the shown schemas of
 * the shown databases of connected instances, wherever the catalog is loaded. Containers never match
 * themselves; they stay only as ancestors of a match. Order follows the tree.
 */
export function filterTree(
  tokens: readonly string[],
  configs: Record<ConnectionId, ConnectionConfig>,
  connections: Record<ConnectionId, ConnectionState>,
  views: Record<DbKey, CatalogView>,
): TreeFilter {
  let count = 0;
  let searched = 0;
  const filtered = Object.values(configs)
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((config): FilteredConnection[] => {
      const shown = instanceOf(connections[config.id])?.databases.filter((d) => d.shown) ?? [];
      const databases = shown.flatMap((state): FilteredDatabase[] => {
        const db = { connectionId: config.id, database: state.name };
        const view = viewFor(views, db);
        if (!view) return [];
        searched++;
        const schemas = state.shownSchemas.flatMap((name): FilteredSchema[] => {
          const schema = view.catalog.schemas.find((s) => s.name === name);
          if (!schema) return [];
          const ordered = [...schema.relations.filter((r) => !isViewKind(r.kind)), ...schema.relations.filter((r) => isViewKind(r.kind))];
          const relations = ordered.flatMap((rel) => filterRelation(tokens, rel) ?? []);
          const functions = schema.functions.flatMap((fn) => {
            const ranges = matchRanges(tokens, fn.name);
            return ranges ? [{ fn, ranges }] : [];
          });
          count += relations.reduce((n, r) => n + (r.ranges ? 1 : 0) + r.columns.length, 0) + functions.length;
          return relations.length > 0 || functions.length > 0 ? [{ name, relations, functions }] : [];
        });
        return schemas.length > 0 ? [{ db, schemas }] : [];
      });
      return databases.length > 0 ? [{ config, databases }] : [];
    });
  return { connections: filtered, count, searched };
}

/** The first table or view the filtered tree lists, which Enter in the search box opens. */
export function firstRelation(filter: TreeFilter): RelationRef | null {
  for (const { databases } of filter.connections) {
    for (const { db, schemas } of databases) {
      for (const schema of schemas) {
        const rel = schema.relations[0];
        if (rel) return { db, schema: schema.name, relation: rel.rel.name };
      }
    }
  }
  return null;
}

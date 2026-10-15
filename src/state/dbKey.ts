import type { ConnectionConfig, DatabaseRef } from "../ipc/bindings";

/** Map key for a DatabaseRef. NUL cannot appear in a Postgres identifier, so the join is exact. */
export type DbKey = string & { readonly __brand: "DbKey" };

export function dbKey(ref: DatabaseRef): DbKey {
  return `${ref.connectionId}\u0000${ref.database}` as DbKey;
}

export function sameDb(a: DatabaseRef | null | undefined, b: DatabaseRef | null | undefined): boolean {
  return a === b || (!!a && !!b && a.connectionId === b.connectionId && a.database === b.database);
}

/** The connection's configured database: the one it connects to first and the tree shows. */
export function homeDb(config: ConnectionConfig): DatabaseRef {
  return { connectionId: config.id, database: config.database };
}

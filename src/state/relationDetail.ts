import { create } from "zustand";
import { commands, type DatabaseRef, type RelationDetail } from "../ipc/bindings";
import { detailErrorText } from "../ipc/errors";
import { dbKey } from "./dbKey";

/**
 * One relation's detail as of catalog `version`. A refetch for a newer version keeps the old
 * `detail` on screen until the new one arrives, so the groups do not flash empty after DDL.
 */
export type DetailEntry = { version: number; detail: RelationDetail | null; error: string | null };

export type DetailKey = string & { readonly __brand: "DetailKey" };

export function detailKey(db: DatabaseRef, oid: number): DetailKey {
  return `${dbKey(db)}\u0000${oid}` as DetailKey;
}

type DetailStore = {
  entries: Record<DetailKey, DetailEntry>;
  /** Fetches `relation_detail` unless an entry at `version` or newer is held or in flight. A failed entry refetches. */
  ensure(db: DatabaseRef, version: number, oid: number): Promise<void>;
};

export const useRelationDetail = create<DetailStore>()((set, get) => ({
  entries: {},
  async ensure(db, version, oid) {
    const key = detailKey(db, oid);
    const held = get().entries[key];
    if (held && held.version >= version && held.error === null) return;
    const put = (entry: DetailEntry) => set((s) => ({ entries: { ...s.entries, [key]: entry } }));
    put({ version, detail: held?.detail ?? null, error: null });
    const res = await commands.relationDetail(db, oid);
    const now = get().entries[key];
    if (now?.version !== version) return;
    if (res.status === "ok") put({ version: Math.max(version, res.data.catalogVersion), detail: res.data, error: null });
    else put({ version, detail: null, error: detailErrorText(res.error) });
  },
}));

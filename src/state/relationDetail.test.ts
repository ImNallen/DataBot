import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, type DatabaseRef, type RelationDetail } from "../ipc/bindings";
import { shopCatalog } from "../testing/shopCatalog";
import { buildCatalogView } from "./catalog";
import { dbKey } from "./dbKey";
import { detailKey, useRelationDetail } from "./relationDetail";

const shop: DatabaseRef = { connectionId: "c1", database: "shop" };
const detail = (oid: number, catalogVersion: number): RelationDetail => ({
  db: shop,
  oid,
  catalogVersion,
  defaults: [],
  keys: [],
  indexes: [],
  triggers: [],
});

afterEach(() => {
  vi.restoreAllMocks();
  useRelationDetail.setState({ entries: {} });
});

describe("useRelationDetail.ensure", () => {
  it("records a thrown IPC error, and the next ensure at the same version refetches", async () => {
    vi.spyOn(commands, "relationDetail").mockRejectedValueOnce(new Error("dev-bridge: connection refused"));
    await useRelationDetail.getState().ensure(shop, 3, 42);
    expect(useRelationDetail.getState().entries[detailKey(shop, 42)]).toEqual({ version: 3, detail: null, error: "dev-bridge: connection refused" });

    vi.spyOn(commands, "relationDetail").mockResolvedValueOnce({ status: "ok", data: detail(42, 3) });
    await useRelationDetail.getState().ensure(shop, 3, 42);
    expect(useRelationDetail.getState().entries[detailKey(shop, 42)]).toEqual({ version: 3, detail: detail(42, 3), error: null });
  });
});

describe("useRelationDetail.prune", () => {
  it("keeps only entries for relations the held catalogs list", () => {
    const view = buildCatalogView(shopCatalog("c1", 1));
    const orders = view.catalog.schemas[1]!.relations.find((r) => r.name === "orders")!;
    const entry = { version: 1, detail: null, error: null };
    const other: DatabaseRef = { connectionId: "c2", database: "shop" };
    useRelationDetail.setState({
      entries: { [detailKey(shop, orders.oid)]: entry, [detailKey(shop, 999_999)]: entry, [detailKey(other, orders.oid)]: entry },
    });
    const views = { [dbKey(shop)]: view };
    useRelationDetail.getState().prune(views);
    expect(Object.keys(useRelationDetail.getState().entries)).toEqual([detailKey(shop, orders.oid)]);
    const unchanged = useRelationDetail.getState().entries;
    useRelationDetail.getState().prune(views);
    expect(useRelationDetail.getState().entries).toBe(unchanged);
  });
});

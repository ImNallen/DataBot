import { describe, expect, it } from "vitest";
import { shopCatalog } from "../testing/shopCatalog";
import { buildCatalogView, isPrimaryKey, useCatalog } from "./catalog";
import { dbKey } from "./dbKey";

const view = buildCatalogView(shopCatalog("conn", 7));

describe("buildCatalogView", () => {
  it("builds a lang-sql namespace keyed schema -> table -> columns with types", () => {
    const publicNs = (view.completion as Record<string, Record<string, { self: { label: string }; children: { label: string; detail?: string }[] }>>).public!;
    expect(Object.keys(publicNs)).toContain("orders");
    expect(publicNs.orders!.self.label).toBe("orders");
    expect(publicNs.orders!.children.map((c) => `${c.label}:${c.detail}`)).toEqual([
      "id:bigint",
      "customer_id:bigint",
      "status:text",
      "total:numeric(12,2)",
      "created_at:timestamptz",
    ]);
    expect(Object.keys(view.completion)).toEqual(["lab", "public"]);
  });

  it("indexes relations by oid", () => {
    const orders = view.catalog.schemas[1]!.relations.find((r) => r.name === "orders")!;
    expect(view.relationsById.get(orders.oid)).toEqual({ schema: "public", rel: orders });
  });

  it("marks a result column as a primary key only when its source column is one", () => {
    const orders = view.catalog.schemas[1]!.relations.find((r) => r.name === "orders")!;
    const attnum = (name: string) => orders.columns.find((c) => c.name === name)!.attnum;
    expect(isPrimaryKey(view, { tableOid: orders.oid, attnum: attnum("id") })).toBe(true);
    expect(isPrimaryKey(view, { tableOid: orders.oid, attnum: attnum("customer_id") })).toBe(false);
    expect(isPrimaryKey(view, null)).toBe(false);
    expect(isPrimaryKey(undefined, { tableOid: orders.oid, attnum: attnum("id") })).toBe(false);
    expect(isPrimaryKey(view, { tableOid: -1, attnum: 1 })).toBe(false);
  });
});

describe("useCatalog.prune", () => {
  it("keeps only the views in the wanted set", () => {
    const shop = buildCatalogView(shopCatalog("c1", 1));
    const other = buildCatalogView(shopCatalog("c2", 4));
    useCatalog.setState({ views: { [dbKey(shop.catalog.db)]: shop, [dbKey(other.catalog.db)]: other } });
    useCatalog.getState().prune(new Set([dbKey({ connectionId: "c2", database: "shop" })]));
    expect(Object.keys(useCatalog.getState().views)).toEqual(["c2\u0000shop"]);
    expect(useCatalog.getState().views[dbKey({ connectionId: "c2", database: "shop" })]?.catalog.version).toBe(4);
    const unchanged = useCatalog.getState().views;
    useCatalog.getState().prune(new Set([dbKey({ connectionId: "c2", database: "shop" })]));
    expect(useCatalog.getState().views).toBe(unchanged);
  });
});

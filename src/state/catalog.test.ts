import { describe, expect, it } from "vitest";
import { fuzzyRank } from "../features/sidebar/fuzzy";
import { shopCatalog } from "../testing/fakeData";
import { buildCatalogView } from "./catalog";

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
      "total:numeric",
      "created_at:timestamptz",
    ]);
    expect(Object.keys(view.completion)).toEqual(["lab", "public"]);
  });

  it("lists tables, then views, then functions, then table.column items", () => {
    const kinds = view.searchItems.map((i) => i.kind);
    const firstOf = (k: string) => kinds.indexOf(k as (typeof kinds)[number]);
    expect(firstOf("table")).toBe(0);
    expect(firstOf("table")).toBeLessThan(firstOf("view"));
    expect(firstOf("view")).toBeLessThan(firstOf("function"));
    expect(firstOf("function")).toBeLessThan(firstOf("column"));
    expect(view.searchItems.find((i) => i.label === "orders.customer_id")).toMatchObject({ kind: "column", relation: "orders", column: "customer_id", detail: "bigint" });
    expect(view.searchItems.find((i) => i.label === "revenue_by_region")?.kind).toBe("view");
    expect(view.searchItems.find((i) => i.label === "slow_echo")).toMatchObject({ kind: "function", detail: "(secs double precision) → double precision" });
  });

  it("indexes relations by oid", () => {
    const orders = view.catalog.schemas[1]!.relations.find((r) => r.name === "orders")!;
    expect(view.relationsById.get(orders.oid)).toEqual({ schema: "public", rel: orders });
  });
});

describe("palette ranking over catalog items", () => {
  const rank = (q: string) => fuzzyRank(q, view.searchItems, (i) => i.label).map((i) => i.label);

  it("finds order_items from space-separated word prefixes", () => {
    expect(rank("ord it")[0]).toBe("order_items");
  });

  it("prefers the exact table over columns and functions sharing the prefix", () => {
    expect(rank("customers")[0]).toBe("customers");
    expect(rank("cust").slice(0, 2)).toEqual(["customers", "customer_ltv"]);
  });

  it("matches word initials and table.column paths", () => {
    expect(rank("oi")).toContain("order_items");
    expect(rank("orders.tot")[0]).toBe("orders.total");
  });

  it("excludes items that do not contain the query in order", () => {
    expect(rank("zzz")).toEqual([]);
    expect(rank("it ord")).not.toContain("order_items");
  });
});

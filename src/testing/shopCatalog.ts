import type { Catalog, ColumnInfo, ConnectionId, FunctionInfo, Relation, RelKind } from "../ipc/bindings";

type TableSpec = { name: string; kind?: RelKind; rows: number | null; columns: string[] };

const TSTZ = "timestamp with time zone";

const SHOP: TableSpec[] = [
  { name: "addresses", rows: 18_400, columns: ["id|bigint|pk", "customer_id|bigint", "line1|text", "city|text", "postal_code|text|null"] },
  { name: "categories", rows: 20, columns: ["id|bigint|pk", "name|text", "parent_id|bigint|null"] },
  { name: "coupons", rows: 3, columns: ["code|text|pk", "percent_off|smallint", "expires_at|date|null"] },
  { name: "customers", rows: 18_400, columns: ["id|bigint|pk", "email|text", "name|text", "region|text", `created_at|${TSTZ}`] },
  { name: "inventory", rows: 1_200, columns: ["product_id|bigint|pk", "supplier_id|bigint|null", "on_hand|integer"] },
  { name: "order_items", rows: 612_000, columns: ["id|bigint|pk", "order_id|bigint", "product_id|bigint", "quantity|integer", "unit_price|numeric(10,2)"] },
  { name: "orders", rows: 241_000, columns: ["id|bigint|pk", "customer_id|bigint", "status|text", "total|numeric(12,2)", `created_at|${TSTZ}`] },
  { name: "payments", rows: 238_000, columns: ["id|bigint|pk", "order_id|bigint", "amount|numeric(12,2)", "method|text", `paid_at|${TSTZ}`] },
  { name: "products", rows: 1_200, columns: ["id|bigint|pk", "sku|text", "name|text", "price|numeric(10,2)", "category_id|bigint|null"] },
  { name: "reviews", rows: 9_000, columns: ["id|bigint|pk", "product_id|bigint", "customer_id|bigint", "rating|smallint", "body|text|null"] },
  { name: "shipments", rows: 120_500, columns: ["id|bigint|pk", "order_id|bigint", "carrier|text", `shipped_at|${TSTZ}|null`] },
  { name: "suppliers", rows: 40, columns: ["id|bigint|pk", "name|text", "country|text"] },
  { name: "low_stock", kind: "View", rows: null, columns: ["sku|text|null", "name|text|null", "on_hand|integer|null"] },
  { name: "paid_orders", kind: "View", rows: null, columns: ["id|bigint|null", "status|text|null", "total|numeric(12,2)|null"] },
  { name: "revenue_by_region", kind: "View", rows: null, columns: ["region|text|null", "revenue|numeric|null"] },
];

const SHOP_FUNCTIONS: FunctionInfo[] = [
  { oid: 17001, name: "apply_coupon", args: "amount numeric, code text", returns: "numeric", kind: "Function" },
  { oid: 17002, name: "customer_ltv", args: "cust bigint", returns: "numeric", kind: "Function" },
  { oid: 17003, name: "order_count", args: "cust bigint", returns: "bigint", kind: "Function" },
  { oid: 17004, name: "slow_echo", args: "secs double precision", returns: "double precision", kind: "Function" },
  { oid: 17005, name: "touch_order", args: "oid bigint", returns: "void", kind: "Function" },
];

const LAB: TableSpec[] = [{ name: "type_zoo", rows: 2, columns: ["id|integer|pk", `tstz|${TSTZ}|null`, "m|lab.mood|null"] }];

function relation(spec: TableSpec, oid: number): Relation {
  return {
    oid,
    name: spec.name,
    kind: spec.kind ?? "Table",
    rowEstimate: spec.rows,
    columns: spec.columns.map((c, i): ColumnInfo => {
      const [name = "", typeDisplay = "", ...flags] = c.split("|");
      return { attnum: i + 1, name, typeDisplay, category: "Other", notNull: !flags.includes("null"), pk: flags.includes("pk"), fk: false };
    }),
  };
}

export function shopCatalog(connectionId: ConnectionId, version: number): Catalog {
  return {
    db: { connectionId, database: "shop" },
    version,
    defaultSchema: "public",
    schemas: [
      { name: "lab", system: false, relationCount: LAB.length, relations: LAB.map((s, i) => relation(s, 16_900 + i)), functions: [] },
      { name: "public", system: false, relationCount: SHOP.length, relations: SHOP.map((s, i) => relation(s, 16_400 + i)), functions: SHOP_FUNCTIONS },
    ],
  };
}

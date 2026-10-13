import type { Catalog, ColumnInfo, ColumnMeta, ConnectionId, FunctionInfo, Relation, RelKind, TypeCategory } from "../ipc/bindings";

/** Columns as `name type [pk] [null]`, mirroring dev/seed.sql. */
type TableSpec = { name: string; kind?: RelKind; rows: number | null; columns: string[] };

const SHOP: TableSpec[] = [
  { name: "addresses", rows: 18_400, columns: ["id bigint pk", "customer_id bigint", "line1 text", "city text", "postal_code text null"] },
  { name: "categories", rows: 20, columns: ["id bigint pk", "name text", "parent_id bigint null"] },
  { name: "coupons", rows: 3, columns: ["code text pk", "percent_off smallint", "expires_at date null"] },
  { name: "customers", rows: 18_400, columns: ["id bigint pk", "email text", "name text", "region text", "created_at timestamptz"] },
  { name: "inventory", rows: 1_200, columns: ["product_id bigint pk", "supplier_id bigint null", "on_hand integer"] },
  { name: "order_items", rows: 612_000, columns: ["id bigint pk", "order_id bigint", "product_id bigint", "quantity integer", "unit_price numeric"] },
  { name: "orders", rows: 241_000, columns: ["id bigint pk", "customer_id bigint", "status text", "total numeric", "created_at timestamptz"] },
  { name: "payments", rows: 238_000, columns: ["id bigint pk", "order_id bigint", "amount numeric", "method text", "paid_at timestamptz"] },
  { name: "products", rows: 1_200, columns: ["id bigint pk", "sku text", "name text", "price numeric", "category_id bigint null"] },
  { name: "reviews", rows: 9_000, columns: ["id bigint pk", "product_id bigint", "customer_id bigint", "rating smallint", "body text null"] },
  { name: "shipments", rows: 120_500, columns: ["id bigint pk", "order_id bigint", "carrier text", "shipped_at timestamptz null"] },
  { name: "suppliers", rows: 40, columns: ["id bigint pk", "name text", "country text"] },
  { name: "low_stock", kind: "View", rows: null, columns: ["sku text null", "name text null", "on_hand integer null"] },
  { name: "paid_orders", kind: "View", rows: null, columns: ["id bigint null", "customer_id bigint null", "status text null", "total numeric null", "created_at timestamptz null"] },
  { name: "revenue_by_region", kind: "View", rows: null, columns: ["region text null", "revenue numeric null"] },
];

const SHOP_FUNCTIONS: FunctionInfo[] = [
  { oid: 17001, name: "apply_coupon", args: "amount numeric, code text", returns: "numeric", kind: "Function" },
  { oid: 17002, name: "customer_ltv", args: "cust bigint", returns: "numeric", kind: "Function" },
  { oid: 17003, name: "order_count", args: "cust bigint", returns: "bigint", kind: "Function" },
  { oid: 17004, name: "slow_echo", args: "secs double precision", returns: "double precision", kind: "Function" },
  { oid: 17005, name: "touch_order", args: "oid bigint", returns: "void", kind: "Function" },
];

const LAB: TableSpec[] = [
  {
    name: "type_zoo",
    rows: 2,
    columns: [
      "id integer pk", "b boolean null", "i8 bigint null", "n numeric null", "t text null", "u uuid null",
      "jb jsonb null", "ba bytea null", "tstz timestamptz null", "iv interval null", "ip inet null",
      "arr_i integer[] null", "m lab.mood null", "rng int4range null",
    ],
  },
];

function relation(spec: TableSpec, oid: number): Relation {
  return {
    oid,
    name: spec.name,
    kind: spec.kind ?? "Table",
    rowEstimate: spec.rows,
    columns: spec.columns.map((c, i): ColumnInfo => {
      const [name = "", typeDisplay = "", ...flags] = c.split(" ");
      return { attnum: i + 1, name, typeDisplay, notNull: !flags.includes("null"), pk: flags.includes("pk") };
    }),
  };
}

export function shopCatalog(connectionId: ConnectionId, version: number): Catalog {
  return {
    connectionId,
    version,
    database: "shop",
    schemas: [
      { name: "lab", relations: LAB.map((s, i) => relation(s, 16_900 + i)), functions: [] },
      { name: "public", relations: SHOP.map((s, i) => relation(s, 16_400 + i)), functions: SHOP_FUNCTIONS },
    ],
  };
}

export function categoryOf(typeDisplay: string): TypeCategory {
  if (typeDisplay.endsWith("[]")) return "Array";
  if (/^(smallint|integer|bigint|numeric|real|double precision|money)/.test(typeDisplay)) return "Numeric";
  if (/^(timestamp|timestamptz|date|time|interval)/.test(typeDisplay)) return "Temporal";
  if (/^(text|varchar|char|name)/.test(typeDisplay)) return "Text";
  if (typeDisplay === "boolean") return "Bool";
  if (typeDisplay.startsWith("json")) return "Json";
  if (typeDisplay === "bytea") return "Binary";
  if (typeDisplay === "uuid") return "Uuid";
  if (typeDisplay === "inet") return "Network";
  if (typeDisplay.endsWith("range")) return "Range";
  if (typeDisplay.includes(".")) return "Enum";
  return "Other";
}

const OIDS: Record<string, number> = { bigint: 20, smallint: 21, integer: 23, text: 25, numeric: 1700, timestamptz: 1184, date: 1082, boolean: 16 };

export function columnMeta(name: string, typeDisplay: string): ColumnMeta {
  return { name, type: { oid: OIDS[typeDisplay] ?? 0, display: typeDisplay, category: categoryOf(typeDisplay) }, source: null };
}

/** Deterministic noise so a cell renders the same text every time it is paged in. */
function noise(row: number, col: number): number {
  let h = (row + 1) * 2_654_435_761 + (col + 1) * 40_503;
  h = Math.imul(h ^ (h >>> 15), 2_246_822_507);
  h = Math.imul(h ^ (h >>> 13), 3_266_489_909);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

const REGIONS = ["US-East", "US-West", "EU-West", "EU-North", "APAC", "LATAM"];
const STATUSES = ["paid", "paid", "paid", "pending", "refunded", "cancelled"];
const BASE_MS = Date.UTC(2026, 9, 13, 8, 14, 0);

function timestamp(row: number, col: number): string {
  const d = new Date(BASE_MS - Math.floor(noise(row, col) * 365 * 86_400_000));
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}+02`;
}

export const LONG_NOTE = `${"A very long note that keeps going. ".repeat(80)}(end)`;

/** A synthetic cell for column `name` of type `typeDisplay`, keyed by absolute row. */
export function syntheticCell(name: string, typeDisplay: string, notNull: boolean, row: number, col: number): string | null {
  const r = noise(row, col);
  if (!notNull && r < 0.12) return null;
  if (col === 0 && name.endsWith("id")) return String(row + 1);
  if (name === "email") return `user${row + 1}@example.com`;
  if (name === "region") return REGIONS[Math.floor(r * REGIONS.length)]!;
  if (name === "status") return STATUSES[Math.floor(r * STATUSES.length)]!;
  if (name === "note") return row % 50 === 7 ? LONG_NOTE : `note ${row + 1}`;
  switch (categoryOf(typeDisplay)) {
    case "Numeric":
      return typeDisplay === "numeric" ? (10 + r * 1_200_000).toFixed(2) : String(1 + Math.floor(r * 240_000));
    case "Temporal":
      return typeDisplay === "date" ? timestamp(row, col).slice(0, 10) : timestamp(row, col);
    case "Bool":
      return r < 0.5 ? "t" : "f";
    default:
      return `${name.replace(/_/g, " ")} ${row + 1}`;
  }
}

/** The mockup's query result, verbatim. */
export const MOCKUP_RESULT = {
  columns: [
    columnMeta("region", "text"),
    columnMeta("orders", "bigint"),
    columnMeta("revenue", "numeric"),
    columnMeta("avg_order", "numeric"),
    columnMeta("last_order", "timestamptz"),
  ],
  rows: [
    ["US-East", "3402", "1021447.90", "300.25", "2026-10-13 10:14:07.412+02"],
    ["US-West", "2876", "864120.00", "300.46", "2026-10-13 10:09:51.006+02"],
    ["EU-West", "2117", "598214.20", "282.58", "2026-10-13 10:02:33.918+02"],
    ["EU-North", "1284", "412880.50", "321.56", "2026-10-13 09:41:12.270+02"],
    ["APAC", "1559", "401322.75", "257.42", "2026-10-13 09:58:45.003+02"],
    ["LATAM", "742", "168904.10", "227.63", "2026-10-12 23:17:29.551+02"],
  ] as (string | null)[][],
};

export const MOCKUP_SQL = `-- Revenue by region, last 90 days
SELECT
  c.region,
  count(o.id)               AS orders,
  sum(o.total)              AS revenue,
  round(avg(o.total), 2)  AS avg_order,
  max(o.created_at)       AS last_order
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.created_at >= now() - interval '90 days'
  AND o.status = 'paid'
GROUP BY c.region
ORDER BY revenue DESC;
`;

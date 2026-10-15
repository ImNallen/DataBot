import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { ColumnMeta, TypeCategory } from "../../ipc/bindings";
import { buildCatalogView } from "../../state/catalog";
import { dbKey } from "../../state/dbKey";
import { shopCatalog } from "../../testing/shopCatalog";
import { HeaderIcon, nextFocus, primaryKeyColumns, selectRows } from "./ResultGrid";

const iconOf = (category: TypeCategory, primaryKey = false) => {
  const html = renderToStaticMarkup(<HeaderIcon column={{ name: "c", type: { oid: 0, display: "t", category }, source: null }} primaryKey={primaryKey} />);
  return html.match(/tabler-icon-([a-z-]+)/)?.[1];
};

it("marks each column with an icon for its type", () => {
  const categories: TypeCategory[] = ["Integer", "Numeric", "Text", "Bool", "Temporal", "Json", "Uuid", "Binary", "Network", "Array", "Enum", "Composite", "Range", "Other"];
  expect(categories.map((c) => iconOf(c))).toEqual([
    "hash",
    "hash",
    "letter-case",
    "toggle-left",
    "calendar",
    "json",
    "fingerprint",
    "binary",
    "network",
    "brackets",
    "list",
    "box",
    "arrows-horizontal",
    "circle-dot",
  ]);
});

it("shows the key instead of the type on a primary key column", () => {
  expect(iconOf("Integer", true)).toBe("key-filled");
});

it("looks primary keys up in the catalog of the database the rows came from", () => {
  const shop = buildCatalogView(shopCatalog("conn", 1));
  const orders = shop.catalog.schemas[1]!.relations.find((r) => r.name === "orders")!;
  // In `reporting`, the OID `orders` has in `shop` belongs to a table whose key is its second column.
  const reporting = buildCatalogView({
    db: { connectionId: "conn", database: "reporting" },
    version: 2,
    schemas: [
      {
        name: "public",
        relations: [
          {
            ...orders,
            name: "daily",
            columns: [
              { ...orders.columns[0]!, name: "orders", pk: false },
              { ...orders.columns[1]!, name: "day", pk: true },
            ],
          },
        ],
        functions: [],
      },
    ],
  });
  const views = { [dbKey(shop.catalog.db)]: shop, [dbKey(reporting.catalog.db)]: reporting };
  const column = (name: string, attnum: number): ColumnMeta => ({ name, type: { oid: 20, display: "bigint", category: "Numeric" }, source: { tableOid: orders.oid, attnum } });
  const columns = [column("a", orders.columns[0]!.attnum), column("b", orders.columns[1]!.attnum)];
  expect(primaryKeyColumns(views, { db: { connectionId: "conn", database: "shop" }, columns })).toEqual([true, false]);
  expect(primaryKeyColumns(views, { db: { connectionId: "conn", database: "reporting" }, columns })).toEqual([false, true]);
  expect(primaryKeyColumns(views, { db: { connectionId: "conn", database: "postgres" }, columns })).toEqual([false, false]);
});

it("moves the active cell by key, clamped to the result", () => {
  const from = { row: 5, col: 2 };
  const at = (key: string, mod = false) => nextFocus(key, mod, from, 100, 8);
  expect(at("ArrowDown")).toEqual({ row: 6, col: 2 });
  expect(at("ArrowLeft")).toEqual({ row: 5, col: 1 });
  expect(at("PageUp")).toEqual({ row: 0, col: 2 });
  expect(at("PageDown")).toEqual({ row: 25, col: 2 });
  expect(at("Tab")).toBeNull();
});

it("jumps to the edges with Home, End, and the modifier", () => {
  const from = { row: 5, col: 2 };
  const at = (key: string, mod = false) => nextFocus(key, mod, from, 100, 8);
  expect(at("Home")).toEqual({ row: 5, col: 0 });
  expect(at("End")).toEqual({ row: 5, col: 7 });
  expect(at("Home", true)).toEqual({ row: 0, col: 0 });
  expect(at("End", true)).toEqual({ row: 99, col: 7 });
  expect(at("ArrowDown", true)).toEqual({ row: 99, col: 2 });
  expect(at("ArrowUp", true)).toEqual({ row: 0, col: 2 });
  expect(at("ArrowRight", true)).toEqual({ row: 5, col: 7 });
  expect(at("ArrowLeft", true)).toEqual({ row: 5, col: 0 });
});

it("selects whole rows from the first to the last column, focused on the first", () => {
  expect(selectRows(4, 4, 6)).toEqual({ anchor: { row: 4, col: 5 }, focus: { row: 4, col: 0 } });
  expect(selectRows(2, 7, 6)).toEqual({ anchor: { row: 2, col: 5 }, focus: { row: 7, col: 0 } });
});

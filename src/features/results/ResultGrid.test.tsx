import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { TypeCategory } from "../../ipc/bindings";
import { HeaderIcon, nextFocus, selectRows } from "./ResultGrid";

const iconOf = (category: TypeCategory, primaryKey = false) => {
  const html = renderToStaticMarkup(<HeaderIcon column={{ name: "c", type: { oid: 0, display: "t", category }, source: null }} primaryKey={primaryKey} />);
  return html.match(/tabler-icon-([a-z-]+)/)?.[1];
};

it("marks each column with an icon for its type", () => {
  const categories: TypeCategory[] = ["Numeric", "Text", "Bool", "Temporal", "Json", "Uuid", "Binary", "Network", "Array", "Enum", "Composite", "Range", "Other"];
  expect(categories.map((c) => iconOf(c))).toEqual([
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
  expect(iconOf("Numeric", true)).toBe("key-filled");
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

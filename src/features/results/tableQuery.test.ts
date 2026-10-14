import { expect, it } from "vitest";
import { filterForValue, formatOrderBy, nextSort, parseOrderBy } from "./tableQuery";

const asc = (column: string) => ({ column, desc: false });
const desc = (column: string) => ({ column, desc: true });

it("cycles a plain-clicked column ascending, descending, off, replacing other keys", () => {
  expect(nextSort([], "a", false)).toEqual([asc("a")]);
  expect(nextSort([asc("a")], "a", false)).toEqual([desc("a")]);
  expect(nextSort([desc("a")], "a", false)).toEqual([]);
  expect(nextSort([asc("a"), desc("b")], "b", false)).toEqual([]);
  expect(nextSort([asc("a")], "b", false)).toEqual([asc("b")]);
});

it("cycles a shift-clicked column in place and keeps the other keys", () => {
  expect(nextSort([asc("a")], "b", true)).toEqual([asc("a"), asc("b")]);
  expect(nextSort([asc("a"), asc("b")], "a", true)).toEqual([desc("a"), asc("b")]);
  expect(nextSort([desc("a"), asc("b")], "a", true)).toEqual([asc("b")]);
});

it("filters by a cell's value, using IS NULL for nulls", () => {
  expect(filterForValue("region", "EU-West", false)).toEqual({ column: "region", op: "Eq", value: "EU-West" });
  expect(filterForValue("region", "EU-West", true)).toEqual({ column: "region", op: "Ne", value: "EU-West" });
  expect(filterForValue("region", null, false)).toEqual({ column: "region", op: "IsNull", value: "" });
  expect(filterForValue("region", null, true)).toEqual({ column: "region", op: "NotNull", value: "" });
});

it("writes header sorts as ORDER BY text and reads them back", () => {
  const keys = [desc("created_at"), asc("Region"), asc("order")];
  expect(formatOrderBy(keys)).toBe('created_at DESC, "Region", "order"');
  expect(parseOrderBy(formatOrderBy(keys))).toEqual(keys);
  expect(parseOrderBy("")).toEqual([]);
  expect(parseOrderBy('Name asc, "a,b" desc')).toEqual([asc("name"), desc("a,b")]);
});

it("leaves ORDER BY expressions it can't read as columns alone", () => {
  expect(parseOrderBy("lower(name) DESC")).toBeNull();
  expect(parseOrderBy("name NULLS LAST")).toBeNull();
  expect(parseOrderBy("name,")).toBeNull();
});

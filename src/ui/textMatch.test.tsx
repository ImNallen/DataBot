import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Highlight } from "./primitives";
import { matchRanges, parseQuery } from "./textMatch";

it("splits a query into lowercase words and reads blank text as no filter", () => {
  expect(parseQuery("  Order\tITEMS  id ")).toEqual(["order", "items", "id"]);
  expect(parseQuery(" \n ")).toEqual([]);
});

it("matches only when every word is a substring, ignoring case", () => {
  expect(matchRanges(parseQuery("ORDER"), "paid_orders")).toEqual([{ start: 5, end: 10 }]);
  expect(matchRanges(parseQuery("item order"), "order_items")).toEqual([
    { start: 0, end: 5 },
    { start: 6, end: 10 },
  ]);
  expect(matchRanges(parseQuery("order zz"), "order_items")).toBeNull();
});

it("is not fuzzy: letters in order but apart do not match", () => {
  expect(matchRanges(parseQuery("font"), "comfortable layout")).toBeNull();
  expect(matchRanges(parseQuery("oi"), "order_items")).toBeNull();
});

it("merges overlapping and touching ranges and marks each word's first occurrence", () => {
  expect(matchRanges(parseQuery("ord der"), "orders")).toEqual([{ start: 0, end: 5 }]);
  expect(matchRanges(parseQuery("pay ment"), "payments")).toEqual([{ start: 0, end: 7 }]);
  expect(matchRanges(parseQuery("o"), "foo_bar_o")).toEqual([{ start: 1, end: 2 }]);
});

it("marks each matched range of a name and leaves the rest as text", () => {
  const ranges = matchRanges(parseQuery("order"), "audit_order_log");
  expect(renderToStaticMarkup(<Highlight text="audit_order_log" ranges={ranges} />)).toBe(
    'audit_<mark class="rounded-[2px] bg-amber/20 text-inherit">order</mark>_log',
  );
  expect(renderToStaticMarkup(<Highlight text="orders" ranges={null} />)).toBe("orders");
});

import { expect, it } from "vitest";
import { browseQuery } from "./runActions";

it("quotes only the identifiers that need it in a table's browse query", () => {
  expect(browseQuery("public", "customers")).toBe("SELECT * FROM public.customers");
  expect(browseQuery("public", "order")).toBe('SELECT * FROM public."order"');
  expect(browseQuery("Sales", "line items")).toBe('SELECT * FROM "Sales"."line items"');
  expect(browseQuery("public", 'say "hi"')).toBe('SELECT * FROM public."say ""hi"""');
});

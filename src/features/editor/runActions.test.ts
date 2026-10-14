import { expect, it } from "vitest";
import { useWorkspace } from "../../state/workspace";
import { browseQuery, openTableTab } from "./runActions";

it("quotes only the identifiers that need it in a table's browse query", () => {
  expect(browseQuery("public", "customers")).toBe("SELECT * FROM public.customers");
  expect(browseQuery("public", "order")).toBe('SELECT * FROM public."order"');
  expect(browseQuery("Sales", "line items")).toBe('SELECT * FROM "Sales"."line items"');
  expect(browseQuery("public", 'say "hi"')).toBe('SELECT * FROM public."say ""hi"""');
});

it("opens the results when a table opens, new or already in a tab", () => {
  const ref = { connectionId: "c1", schema: "public", relation: "orders" };
  useWorkspace.setState({ layout: { ...useWorkspace.getState().layout, results: false } });
  openTableTab(ref);
  const tab = useWorkspace.getState().tabs[useWorkspace.getState().active!];
  expect([tab?.kind, useWorkspace.getState().layout.results]).toEqual(["table", true]);

  useWorkspace.setState({ layout: { ...useWorkspace.getState().layout, results: false } });
  openTableTab(ref);
  expect(Object.keys(useWorkspace.getState().tabs)).toHaveLength(1);
  expect(useWorkspace.getState().layout.results).toBe(true);
});

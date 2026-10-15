import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { buildCatalogView, useCatalog } from "../../state/catalog";
import { dbKey } from "../../state/dbKey";
import { useLive } from "../../state/live";
import { useWorkspace } from "../../state/workspace";
import { connectedState, connectionConfig, databaseState } from "../../testing/connections";
import { shopCatalog } from "../../testing/shopCatalog";
import { Sidebar } from "./Sidebar";

const initial = { workspace: { ...useWorkspace.getInitialState() }, live: { ...useLive.getInitialState() }, catalog: { ...useCatalog.getInitialState() } };

afterEach(() => {
  Object.assign(useWorkspace.getInitialState(), initial.workspace);
  Object.assign(useLive.getInitialState(), initial.live);
  Object.assign(useCatalog.getInitialState(), initial.catalog);
});

// Static rendering reads each store's initial state, so the fixtures go there.
function render(treeQuery: string, loaded = true) {
  Object.assign(useWorkspace.getInitialState(), { treeQuery, configs: { p: connectionConfig("p", "prod") } });
  Object.assign(useLive.getInitialState(), { connections: { p: connectedState("p", [databaseState("shop", true, ["public"])]) } });
  const view = buildCatalogView(shopCatalog("p", 1));
  Object.assign(useCatalog.getInitialState(), { views: loaded ? { [dbKey(view.catalog.db)]: view } : {} });
  return renderToStaticMarkup(<Sidebar hosted={null} />);
}

/** Each tree row as its path, with "+" or "-" when it has an open or closed chevron. */
const rows = (html: string) =>
  [...html.matchAll(/data-testid="tree-node-([^"]+)" role="treeitem"( aria-expanded="(true|false)")?/g)].map(
    ([, path, , open]) => `${path}${open === undefined ? "" : open === "true" ? " +" : " -"}`,
  );

it("narrows the tree to the matches, every node open and each matching column right under its table", () => {
  const html = render("order");
  expect(rows(html)).toEqual([
    "prod +",
    "prod/shop +",
    "prod/shop/public +",
    "prod/shop/public/order_items +",
    "prod/shop/public/order_items/#columns/order_id",
    "prod/shop/public/orders",
    "prod/shop/public/payments +",
    "prod/shop/public/payments/#columns/order_id",
    "prod/shop/public/shipments +",
    "prod/shop/public/shipments/#columns/order_id",
    "prod/shop/public/paid_orders",
    "prod/shop/public/#functions +",
    "prod/shop/public/#functions/order_count",
    "prod/shop/public/#functions/touch_order",
  ]);
  expect(html).toMatch(/data-testid="sidebar-search-count"[^>]*>8</);
  expect(html).toContain('paid_<mark class="rounded-[2px] bg-amber/20 text-inherit">order</mark>s');
  expect(html).toContain('aria-label="Clear search"');
});

it("says why the tree is empty while a search finds nothing", () => {
  const note = (html: string) => /data-testid="tree-search-empty"[^>]*>(.*?)<\/p>/.exec(html)?.[1];
  expect(note(render("zzqx"))).toBe("No matches for “zzqx”.");
  expect(note(render("order", false))).toBe("Connect to a database to search its catalog.");
});

it("draws the whole tree with no count or clear button while the search box is empty", () => {
  const html = render("");
  expect(rows(html)).toEqual(["prod -"]);
  expect(html).not.toContain('data-testid="sidebar-search-count"');
  expect(html).toMatch(/<input[^>]*data-testid="sidebar-search"[^>]*value=""/);
});

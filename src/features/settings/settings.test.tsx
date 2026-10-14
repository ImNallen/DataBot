import { mockIPC } from "@tauri-apps/api/mocks";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { Settings } from "../../ipc/bindings";
import { AppLayout } from "../../shell/AppLayout";
import { clampWidth } from "../../shell/PixelColumn";
import { startTheme } from "../../shell/theme";
import { useWorkspace, type WorkspaceData } from "../../state/workspace";
import { fakeRoot } from "../../testing/fakeRoot";
import { BUILT_IN_FAMILIES } from "../../themes/catalog";
import { addCustomThemes, chooseColorScheme, chooseThemes, deleteCustomTheme } from "./themeActions";
import { searchSettings } from "./sections";

const initial = { ...useWorkspace.getInitialState() };

afterEach(() => {
  vi.unstubAllGlobals();
  Object.assign(useWorkspace.getInitialState(), initial);
  useWorkspace.setState(useWorkspace.getInitialState(), true);
});

// Static rendering reads zustand's server snapshot, which is the store's initial state, so setState can't reach it.
function render(patch: Partial<WorkspaceData>) {
  Object.assign(useWorkspace.getInitialState(), patch);
  return renderToStaticMarkup(<AppLayout />);
}

const breadcrumb = (html: string) =>
  /data-testid="settings-breadcrumb"[^>]*>(.*?)<\/h1>/.exec(html)?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const settingsOpen = (section: "appearance" | "queries" = "appearance") => ({ screen: { kind: "settings", section } }) as const;

it("puts the settings nav in the sidebar and the section in the main panel, with no workspace chrome", () => {
  const html = render({ ...settingsOpen(), layout: { ...initial.layout, rightPanel: "Assistant" } });
  expect(html).toMatch(/data-testid="sidebar"[^>]*>.*data-testid="settings-nav"/);
  expect(html).toContain('data-testid="settings-back"');
  expect(html).toMatch(/data-testid="settings-search-open"[^>]*>.*Search</);
  expect(breadcrumb(html)).toBe("Settings / Appearance");
  expect(html).toMatch(/aria-current="page"[^>]*data-testid="settings-section-appearance"|data-testid="settings-section-appearance"[^>]*aria-current="page"/);
  for (const absent of ["run-btn", "tab-bar", "no-tabs", "right-panel", "search-open", "new-connection"]) {
    expect(html).not.toContain(`data-testid="${absent}"`);
  }
});

const sidebarHeader = (html: string) => /<div data-tauri-drag-region="deep" class="flex h-\[52px\][^"]*">(?:(?!<\/div>).)*<\/div>/.exec(html)?.[0];

it("keeps the sidebar header, toggle and app title, identical in settings and the workspace", () => {
  const settings = sidebarHeader(render(settingsOpen()));
  const workspace = sidebarHeader(render({ screen: { kind: "workspace" } }));
  expect(settings).toContain('data-testid="toggle-sidebar"');
  expect(settings).toContain('data-testid="app-title"');
  expect(settings).toBe(workspace);
});

const columns = (html: string, testId: "sidebar" | "right") => html.match(new RegExp(`<div data-testid="${testId}"[^>]*>`, "g")) ?? [];

it("draws one sidebar at the stored pixel width in both the workspace and settings, and the right panel at its own", () => {
  const layout = { ...initial.layout, sidebarWidth: 300, rightPanel: "Assistant", rightPanelWidth: 420 } as const;
  const workspace = render({ screen: { kind: "workspace" }, layout });
  const settings = render({ ...settingsOpen(), layout });
  expect(columns(workspace, "sidebar")).toEqual([expect.stringContaining('style="width:300px;')]);
  expect(columns(workspace, "right")).toEqual([expect.stringContaining('style="width:420px;')]);
  expect(columns(settings, "sidebar")).toEqual(columns(workspace, "sidebar"));
  expect(columns(settings, "right")).toEqual([]);
  expect(sidebarHeader(settings)).toBe(sidebarHeader(workspace));
});

it("drops the sidebar on both screens while it is hidden", () => {
  const layout = { ...initial.layout, sidebar: false };
  expect(columns(render({ screen: { kind: "workspace" }, layout }), "sidebar")).toEqual([]);
  expect(columns(render({ ...settingsOpen(), layout }), "sidebar")).toEqual([]);
});

it("keeps the sidebar between 200 and 480 pixels and the right panel between 260 and 560", () => {
  const widths = [150, 200, 340.4, 480, 900];
  expect(widths.map((px) => clampWidth("sidebar", px))).toEqual([200, 200, 340, 480, 480]);
  expect(widths.map((px) => clampWidth("right", px))).toEqual([260, 260, 340, 480, 560]);
});

it("hides the settings nav with the sidebar and moves the toggle into the page header", () => {
  const html = render({ ...settingsOpen(), layout: { ...initial.layout, sidebar: false } });
  expect(html).not.toContain('data-testid="settings-nav"');
  expect(html).toMatch(/<header[^>]*>(?:(?!<\/header>).)*data-testid="toggle-sidebar"/);
});

it("returns to the workspace layout once settings close", () => {
  const html = render({ screen: { kind: "workspace" } });
  expect(html).not.toContain('data-testid="settings-nav"');
  expect(html).toContain('data-testid="app-title"');
  expect(html).toContain('data-testid="no-tabs"');
});

it.each([
  ["dark", "colorScheme"],
  ["dracula", "themes"],
  ["theme", "themes"],
  ["page", "tablePageSize"],
  ["error", "stopOnError"],
  ["row limit", "maxRows"],
])("ranks %s to the %s setting first", (query, id) => {
  expect(searchSettings(query)[0]?.id).toBe(id);
});

it("lists every setting in registry order for an empty query, and nothing for a miss", () => {
  expect(searchSettings(" ").map((s) => s.id)).toEqual(["colorScheme", "themes", "maxRows", "tablePageSize", "stopOnError"]);
  expect(searchSettings("zzqx")).toEqual([]);
});

const radios = (html: string, name: string) =>
  (html.match(/<input type="radio"[^>]*>/g) ?? [])
    .filter((tag) => tag.includes(`name="${name}"`))
    .map((tag) => [/value="([\w-]+)"/.exec(tag)?.[1], tag.includes('checked=""')]);

it("offers the three color schemes as one native radio group with the saved one checked", () => {
  const html = render({ ...settingsOpen(), settings: { ...initial.settings, colorScheme: "Dark" } });
  expect(radios(html, "colorScheme")).toEqual([
    ["System", false],
    ["Light", false],
    ["Dark", true],
  ]);
});

it("offers every theme variant in a light radio group and a dark one, with the saved picks checked", () => {
  const custom = { id: "custom-dusk", name: "Dusk", appearance: "dark", colors: { background: "#1b1824", accent: "#e0a040" } } as const;
  const html = render({ ...settingsOpen(), settings: { ...initial.settings, lightTheme: "ocean-light", darkTheme: "custom-dusk", customThemes: [custom] } });
  const checked = (name: string) => radios(html, name).filter(([, on]) => on).map(([id]) => id);
  expect(radios(html, "lightTheme").map(([id]) => id)).toEqual(["l1-light", "grove-light", "ocean-light", "ember-light", "iris-light", "rose-light"]);
  expect(radios(html, "darkTheme").map(([id]) => id)).toEqual(["l1-dark", "grove-dark", "ocean-dark", "ember-dark", "iris-dark", "rose-dark", "custom-dusk"]);
  expect([checked("lightTheme"), checked("darkTheme")]).toEqual([["ocean-light"], ["custom-dusk"]]);
});

it("shows the query settings with their saved values", () => {
  const html = render({ ...settingsOpen("queries"), settings: { ...initial.settings, maxRows: 1234, tablePageSize: 77, stopOnError: false } });
  expect(breadcrumb(html)).toBe("Settings / Queries");
  expect(html).toMatch(/data-testid="setting-maxRows"[^>]*value="1234"/);
  expect(html).toMatch(/data-testid="setting-tablePageSize"[^>]*value="77"/);
  expect(html).toMatch(/data-testid="setting-stopOnError"(?![^>]*checked)[^>]*>/);
});

function paintAndRecordSaves() {
  const root = fakeRoot();
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }), crypto });
  const saved: Settings[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "settings_set") saved.push((args as { settings: Settings }).settings);
  });
  return { root, saved, stop: startTheme() };
}

const variant = (family: string, appearance: "light" | "dark") => {
  const v = BUILT_IN_FAMILIES.find((f) => f.id === family)?.variants[appearance];
  if (!v) throw new Error(`no ${family} ${appearance}`);
  return v;
};

it("paints the app light and persists Light when the Light color scheme is chosen", async () => {
  const { root, saved, stop } = paintAndRecordSaves();
  expect(root.dataset.theme).toBe("dark");

  await chooseColorScheme("Light");
  stop();
  expect([root.dataset.theme, root.style.colorScheme]).toEqual(["light", "light"]);
  expect(saved).toEqual([{ ...initial.settings, colorScheme: "Light" }]);
});

it("switches a pinned scheme when a theme of the other appearance is picked, and keeps System as it is", async () => {
  const { root, saved, stop } = paintAndRecordSaves();
  await chooseColorScheme("Light");
  await chooseThemes([variant("grove", "dark")]);
  expect([root.dataset.theme, root.style.vars.get("--color-bg")]).toEqual(["dark", "#0c1310"]);

  await chooseColorScheme("System");
  await chooseThemes([variant("iris", "light")]);
  stop();
  expect(root.dataset.theme).toBe("dark");
  expect(saved.at(-1)).toEqual({ ...initial.settings, colorScheme: "System", lightTheme: "iris-light", darkTheme: "grove-dark" });
});

it("sets both picks from a two-variant family without touching the scheme", async () => {
  const { saved, stop } = paintAndRecordSaves();
  await chooseColorScheme("Dark");
  await chooseThemes([variant("rose", "light"), variant("rose", "dark")]);
  stop();
  expect(saved.at(-1)).toEqual({ ...initial.settings, colorScheme: "Dark", lightTheme: "rose-light", darkTheme: "rose-dark" });
});

it("saves created themes, picks the first of each appearance, and drops a deleted pick back to L1", async () => {
  let n = 0;
  vi.stubGlobal("crypto", { randomUUID: () => `id${++n}` });
  const { root, saved, stop } = paintAndRecordSaves();
  await chooseColorScheme("Light");
  await addCustomThemes([
    { name: "Dusk", appearance: "dark", colors: { background: "#1b1824", accent: "#e0a040" } },
    { name: "Night", appearance: "dark", colors: { background: "#000000", accent: "#ffffff" } },
  ]);
  expect([root.dataset.theme, root.style.vars.get("--color-bg")]).toEqual(["dark", "#1b1824"]);
  expect(saved.at(-1)).toMatchObject({ colorScheme: "Dark", lightTheme: "l1-light", darkTheme: "custom-id1" });
  expect(saved.at(-1)?.customThemes.map((t) => [t.id, t.name])).toEqual([["custom-id1", "Dusk"], ["custom-id2", "Night"]]);

  await deleteCustomTheme("custom-id1");
  stop();
  expect(saved.at(-1)).toMatchObject({ darkTheme: "l1-dark", customThemes: [{ id: "custom-id2", name: "Night" }] });
  expect(root.style.vars.size).toBe(0);
});

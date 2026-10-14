import { mockIPC } from "@tauri-apps/api/mocks";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { Settings } from "../../ipc/bindings";
import { AppLayout } from "../../shell/AppLayout";
import { clampSidebarWidth } from "../../shell/SidebarColumn";
import { startTheme } from "../../shell/theme";
import { useWorkspace, type WorkspaceData } from "../../state/workspace";
import { chooseTheme } from "./AppearanceSection";
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

const settingsOpen = (section: "appearance" | "queries" = "appearance") => ({ screen: { kind: "settings", section } }) as const;

it("puts the settings nav in the sidebar and the section in the main panel, with no workspace chrome", () => {
  const html = render({ ...settingsOpen(), layout: { ...initial.layout, rightPanel: "Assistant" } });
  expect(html).toMatch(/data-testid="sidebar"[^>]*>.*data-testid="settings-nav"/);
  expect(html).toContain('data-testid="settings-back"');
  expect(html).toMatch(/data-testid="settings-search-open"[^>]*>.*Search settings/);
  expect(html).toMatch(/<h1[^>]*>Appearance<\/h1>/);
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

const sidebars = (html: string) => html.match(/<div data-testid="sidebar"[^>]*>/g) ?? [];

it("draws one sidebar at the stored pixel width in both the workspace and settings", () => {
  const layout = { ...initial.layout, sidebarWidth: 300 };
  const workspace = render({ screen: { kind: "workspace" }, layout });
  const settings = render({ ...settingsOpen(), layout });
  expect(sidebars(workspace)).toEqual([expect.stringContaining('style="width:300px"')]);
  expect(sidebars(settings)).toEqual(sidebars(workspace));
  expect(sidebarHeader(settings)).toBe(sidebarHeader(workspace));
});

it("drops the sidebar on both screens while it is hidden", () => {
  const layout = { ...initial.layout, sidebar: false };
  expect(sidebars(render({ screen: { kind: "workspace" }, layout }))).toEqual([]);
  expect(sidebars(render({ ...settingsOpen(), layout }))).toEqual([]);
});

it("keeps the sidebar width between 200 and 480 pixels", () => {
  expect([150, 200, 340.4, 480, 900].map(clampSidebarWidth)).toEqual([200, 200, 340, 480, 480]);
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
  ["dark", "theme"],
  ["page", "tablePageSize"],
  ["error", "stopOnError"],
  ["row limit", "maxRows"],
])("ranks %s to the %s setting first", (query, id) => {
  expect(searchSettings(query)[0]?.id).toBe(id);
});

it("lists every setting in registry order for an empty query, and nothing for a miss", () => {
  expect(searchSettings(" ").map((s) => s.id)).toEqual(["theme", "maxRows", "tablePageSize", "stopOnError"]);
  expect(searchSettings("zzqx")).toEqual([]);
});

it("offers the three themes as one native radio group with the saved one checked", () => {
  const html = render({ ...settingsOpen(), settings: { ...initial.settings, theme: "Dark" } });
  const radios = (html.match(/<input type="radio"[^>]*>/g) ?? []).map((tag) => [
    /name="(\w+)"/.exec(tag)?.[1],
    /value="(\w+)"/.exec(tag)?.[1],
    tag.includes('checked=""'),
  ]);
  expect(radios).toEqual([
    ["theme", "System", false],
    ["theme", "Light", false],
    ["theme", "Dark", true],
  ]);
});

it("shows the query settings with their saved values", () => {
  const html = render({ ...settingsOpen("queries"), settings: { ...initial.settings, maxRows: 1234, tablePageSize: 77, stopOnError: false } });
  expect(html).toMatch(/<h1[^>]*>Queries<\/h1>/);
  expect(html).toMatch(/data-testid="setting-maxRows"[^>]*value="1234"/);
  expect(html).toMatch(/data-testid="setting-tablePageSize"[^>]*value="77"/);
  expect(html).toMatch(/data-testid="setting-stopOnError"(?![^>]*checked)[^>]*>/);
});

it("paints the app light and persists Light when the Light theme is chosen", async () => {
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }), crypto });
  const saved: Settings[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "settings_set") saved.push((args as { settings: Settings }).settings);
  });
  const stop = startTheme();
  expect(root.dataset.theme).toBe("dark");

  await chooseTheme("Light");
  stop();
  expect([root.dataset.theme, root.style.colorScheme]).toEqual(["light", "light"]);
  expect(saved).toEqual([{ ...initial.settings, theme: "Light" }]);
});

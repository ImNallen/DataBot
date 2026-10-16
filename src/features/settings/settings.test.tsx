import { mockIPC } from "@tauri-apps/api/mocks";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { CustomTheme, ProviderState, Settings } from "../../ipc/bindings";
import { AppLayout } from "../../shell/AppLayout";
import { clampWidth } from "../../shell/PixelColumn";
import { startAppearance } from "../../shell/appearance";
import { startTheme } from "../../shell/theme";
import { useLive, type LiveData } from "../../state/live";
import { useWorkspace, type WorkspaceData } from "../../state/workspace";
import { fakeRoot } from "../../testing/fakeRoot";
import { BUILT_IN_FAMILIES, customFamily, familyPicks } from "../../themes/catalog";
import { chooseDensity, chooseFont, previewPanelMotion, savePanelMotion } from "./appearanceActions";
import { addCustomThemes, chooseColorScheme, chooseThemes, deleteCustomTheme } from "./themeActions";
import { parseQuery } from "../../ui/textMatch";
import { filterSettings, type SettingsSectionId } from "./settingsIndex";

const initial = { ...useWorkspace.getInitialState() };
const initialLive = { ...useLive.getInitialState() };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Object.assign(useWorkspace.getInitialState(), initial);
  useWorkspace.setState(useWorkspace.getInitialState(), true);
  Object.assign(useLive.getInitialState(), initialLive);
});

// Static rendering reads zustand's server snapshot, which is the store's initial state, so setState can't reach it.
function render(patch: Partial<WorkspaceData>, live: Partial<LiveData> = {}) {
  Object.assign(useWorkspace.getInitialState(), patch);
  Object.assign(useLive.getInitialState(), live);
  return renderToStaticMarkup(<AppLayout />);
}

const breadcrumb = (html: string) =>
  /data-testid="settings-breadcrumb"[^>]*>(.*?)<\/h1>/.exec(html)?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const settingsOpen = (section: SettingsSectionId = "appearance", query = "") => ({ screen: { kind: "settings", section, query } }) as const;

it("puts the settings nav in the sidebar and the section in the main panel, with no workspace chrome", () => {
  const html = render({ ...settingsOpen(), layout: { ...initial.layout, rightPanel: "Assistant" } });
  expect(html).toMatch(/data-testid="sidebar"[^>]*>.*data-testid="settings-nav"/);
  expect(html).toContain('data-testid="settings-back"');
  expect(html).toMatch(/<input[^>]*data-testid="settings-search"[^>]*placeholder="Search"/);
  expect(breadcrumb(html)).toBe("Settings / Appearance");
  expect(html).toMatch(/aria-current="page"[^>]*data-testid="settings-section-appearance"|data-testid="settings-section-appearance"[^>]*aria-current="page"/);
  for (const absent of ["run-btn", "tab-bar", "no-tabs", "right-panel", "sidebar-search", "new-connection"]) {
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

const matching = (query: string) => filterSettings(parseQuery(query)).map((s) => s.id);

it.each([
  ["font", ["interfaceFont", "codeFont"]],
  ["row limit", ["maxRows"]],
  ["results", ["codeFont", "maxRows", "tablePageSize"]],
  ["typography", ["interfaceFont", "codeFont"]],
  ["dark", ["colorScheme"]],
  ["dracula", ["themes"]],
  ["theme", ["themes"]],
  ["page", ["tablePageSize"]],
  ["error", ["stopOnError"]],
  ["compact", ["density"]],
  ["animation", ["panelMotion"]],
  ["tint", ["tintConnections"]],
  ["SF Pro", ["interfaceFont"]],
  ["jetbrains", ["codeFont"]],
  ["binary", ["providerList"]],
  ["claude config", ["providerList"]],
  ["health", ["providerHealthCheck"]],
  ["advanced", ["providerHealthCheck"]],
  ["zzqx", []],
])("filters %j to %j by label, section, group, and keywords", (query, ids) => {
  expect(matching(query)).toEqual(ids);
});

it("lists every setting in registry order for an empty query", () => {
  expect(matching(" ")).toEqual([
    "colorScheme",
    "themes",
    "density",
    "panelMotion",
    "tintConnections",
    "interfaceFont",
    "codeFont",
    "maxRows",
    "tablePageSize",
    "stopOnError",
    "providerList",
    "providerHealthCheck",
  ]);
});

const text = (html: string | undefined) => html?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const summary = (html: string) => text(/data-testid="settings-search-summary"[^>]*>(.*?)<\/p>/.exec(html)?.[1]);
const navEntries = (html: string) =>
  [...html.matchAll(/<button type="button" data-testid="settings-section-(\w+)"( aria-current="page")?[^>]*>(.*?)<\/button>/g)].map(([, id, current, body]) => [
    id,
    text(body),
    current !== undefined,
  ]);
const resultHeadings = (html: string) => [...html.matchAll(/<h2 id="[^"]*" class="mb-2[^"]*">(.*?)<\/h2>/g)].map(([, h]) => text(h));
const settingIds = (html: string) => [...html.matchAll(/data-setting="(\w+)"/g)].map(([, id]) => id);

it("lists the matching settings live in place of the section while a settings search is set", () => {
  const html = render(settingsOpen("queries", "font"));
  expect(breadcrumb(html)).toBe("Settings / Search results");
  expect(summary(html)).toBe("2 settings match “font” Clear search");
  expect(resultHeadings(html)).toEqual(["Appearance · Typography"]);
  expect(settingIds(html)).toEqual(["interfaceFont", "codeFont"]);
  expect(html).toContain('Interface <mark class="rounded-[2px] bg-amber/20 text-inherit">font</mark>');
  expect(html).toMatch(/data-testid="setting-codeFont-family"/);
  expect(navEntries(html)).toEqual([["appearance", "Appearance 2", false]]);
  expect(html).toContain('data-testid="settings-search-hint"');
  expect(html).toMatch(/data-testid="settings-search-count"[^>]*>2</);
});

it("heads each run of results with its section and group, and a bare run with the section alone", () => {
  const html = render(settingsOpen("appearance", "results"));
  expect(resultHeadings(html)).toEqual(["Appearance · Typography", "Queries · Results"]);
  expect(settingIds(html)).toEqual(["codeFont", "maxRows", "tablePageSize"]);
  expect(navEntries(html)).toEqual([
    ["appearance", "Appearance 1", false],
    ["queries", "Queries 2", false],
  ]);
  const scheme = render(settingsOpen("appearance", "scheme"));
  expect([summary(scheme), resultHeadings(scheme), settingIds(scheme)]).toEqual(["1 setting matches “scheme” Clear search", ["Appearance"], ["colorScheme"]]);
});

it("says when no setting matches, and shows the section with every nav entry once the query is blank", () => {
  const html = render(settingsOpen("queries", "zzqx"));
  expect([summary(html), settingIds(html), navEntries(html)]).toEqual(["No settings match “zzqx”. Clear search", [], []]);
  const blank = render(settingsOpen("queries", "  "));
  expect(breadcrumb(blank)).toBe("Settings / Queries");
  expect(navEntries(blank)).toEqual([
    ["appearance", "Appearance", false],
    ["queries", "Queries", true],
    ["providers", "Providers", false],
  ]);
  expect(blank).not.toContain('data-testid="settings-search-hint"');
});

const radioTags = (html: string, name: string) => (html.match(/<input type="radio"[^>]*>/g) ?? []).filter((tag) => tag.includes(`name="${name}"`));
const radios = (html: string, name: string) => radioTags(html, name).map((tag) => [/value="([\w-]+)"/.exec(tag)?.[1], tag.includes('checked=""')]);

it("offers the three color schemes as one native radio group with the saved one checked", () => {
  const html = render({ ...settingsOpen(), settings: { ...initial.settings, colorScheme: "Dark" } });
  expect(radios(html, "colorScheme")).toEqual([
    ["System", false],
    ["Light", false],
    ["Dark", true],
  ]);
});

const catppuccin: CustomTheme = {
  id: "custom-cat",
  name: "Catppuccin for VSCode",
  variants: [
    { id: "custom-cat-0", name: "Catppuccin Latte", appearance: "light", colors: { background: "#eff1f5", accent: "#8839ef" } },
    { id: "custom-cat-1", name: "Catppuccin Frappé", appearance: "dark", colors: { background: "#303446", accent: "#ca9ee6" } },
    { id: "custom-cat-2", name: "Catppuccin Macchiato", appearance: "dark", colors: { background: "#24273a", accent: "#c6a0f6" } },
    { id: "custom-cat-3", name: "Catppuccin Mocha", appearance: "dark", colors: { background: "#1e1e2e", accent: "#cba6f7" } },
  ],
};

it("offers every theme variant in a light radio group and a dark one, with the saved picks checked", () => {
  const custom: CustomTheme = {
    id: "custom-dusk-family",
    name: "Dusk",
    variants: [{ id: "custom-dusk", name: "Dusk", appearance: "dark", colors: { background: "#1b1824", accent: "#e0a040" } }],
  };
  const html = render({ ...settingsOpen(), settings: { ...initial.settings, lightTheme: "ocean-light", darkTheme: "custom-dusk", customThemes: [custom] } });
  const checked = (name: string) => radios(html, name).filter(([, on]) => on).map(([id]) => id);
  expect(radios(html, "lightTheme").map(([id]) => id)).toEqual(["l1-light", "grove-light", "ocean-light", "ember-light", "iris-light", "rose-light"]);
  expect(radios(html, "darkTheme").map(([id]) => id)).toEqual(["l1-dark", "grove-dark", "ocean-dark", "ember-dark", "iris-dark", "rose-dark", "custom-dusk"]);
  expect([checked("lightTheme"), checked("darkTheme")]).toEqual([["ocean-light"], ["custom-dusk"]]);
});

it("puts every variant of an imported extension on one card, each orb a radio named after its variant", () => {
  const html = render({ ...settingsOpen(), settings: { ...initial.settings, darkTheme: "custom-cat-2", customThemes: [catppuccin] } });
  const card = /data-testid="theme-family-custom-cat".*?<\/button>/.exec(html)?.[0] ?? "";
  const orbs = (card.match(/<input type="radio"[^>]*>/g) ?? []).map((tag) => [
    /name="(\w+)"/.exec(tag)?.[1],
    /value="([\w-]+)"/.exec(tag)?.[1],
    /aria-label="([^"]+)"/.exec(tag)?.[1],
    tag.includes('checked=""'),
  ]);
  expect(orbs).toEqual([
    ["lightTheme", "custom-cat-0", "Catppuccin Latte", false],
    ["darkTheme", "custom-cat-1", "Catppuccin Frappé", false],
    ["darkTheme", "custom-cat-2", "Catppuccin Macchiato", true],
    ["darkTheme", "custom-cat-3", "Catppuccin Mocha", false],
  ]);
  expect(card).toContain(">Catppuccin for VSCode</button>");
  expect(html.match(/data-testid="theme-family-custom-cat/g)).toHaveLength(1);
});

it("shows the query settings with their saved values", () => {
  const html = render({ ...settingsOpen("queries"), settings: { ...initial.settings, maxRows: 1234, tablePageSize: 77, stopOnError: false } });
  expect(breadcrumb(html)).toBe("Settings / Queries");
  expect(html).toMatch(/data-testid="setting-maxRows"[^>]*value="1234"/);
  expect(html).toMatch(/data-testid="setting-tablePageSize"[^>]*value="77"/);
  expect(html).toMatch(/data-testid="setting-stopOnError"(?![^>]*checked)[^>]*>/);
});

/** The page's settings in order, each card's title as "# Title" before its settings. */
const layout = (html: string) =>
  [...html.matchAll(/data-setting="(\w+)"|<h2 id="[^"]*" class="mb-2[^"]*">([^<]+)</g)].map(([, setting, card]) => setting ?? `# ${card}`);

it("draws each section's settings in registry order, a run of one group in one card", () => {
  expect(layout(render(settingsOpen()))).toEqual(["colorScheme", "themes", "# Layout", "density", "# Motion", "panelMotion", "# Sidebar", "tintConnections", "# Typography", "interfaceFont", "codeFont"]);
  expect(layout(render(settingsOpen("queries")))).toEqual(["# Results", "maxRows", "tablePageSize", "# Scripts", "stopOnError"]);
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
  const v = BUILT_IN_FAMILIES.find((f) => f.id === family)?.variants.find((x) => x.appearance === appearance);
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

it("saves each added family as one theme, picks from the first family only, and drops a deleted pick back to L1", async () => {
  let n = 0;
  vi.stubGlobal("crypto", { randomUUID: () => `id${++n}` });
  const { root, saved, stop } = paintAndRecordSaves();
  await chooseColorScheme("Light");
  await addCustomThemes([
    { name: "Dusk", variants: [{ name: "Dusk", appearance: "dark", colors: { background: "#1b1824", accent: "#e0a040" } }] },
    { name: "Day", variants: [{ name: "Day", appearance: "light", colors: { background: "#fafafa", accent: "#1477b0" } }] },
  ]);
  expect([root.dataset.theme, root.style.vars.get("--color-bg")]).toEqual(["dark", "#1b1824"]);
  expect(saved.at(-1)).toMatchObject({ colorScheme: "Dark", lightTheme: "l1-light", darkTheme: "custom-id1-0" });
  expect(saved.at(-1)?.customThemes.map((t) => [t.id, t.name, t.variants.map((v) => v.id)])).toEqual([
    ["custom-id1", "Dusk", ["custom-id1-0"]],
    ["custom-id2", "Day", ["custom-id2-0"]],
  ]);

  await deleteCustomTheme("custom-id1");
  stop();
  expect(saved.at(-1)).toMatchObject({ darkTheme: "l1-dark", customThemes: [{ id: "custom-id2", name: "Day" }] });
  expect(root.style.vars.size).toBe(0);
});

it("adds an extension as one theme and picks its first light and first dark", async () => {
  vi.stubGlobal("crypto", { randomUUID: () => "ext" });
  const { saved, stop } = paintAndRecordSaves();
  await addCustomThemes([
    {
      name: "Night Owl",
      variants: [
        { name: "Night Owl", appearance: "dark", colors: { background: "#011627", accent: "#7e57c2" } },
        { name: "Light Owl", appearance: "light", colors: { background: "#fbfbfb", accent: "#2aa298" } },
        { name: "Night Owl (No Italics)", appearance: "dark", colors: { background: "#011627", accent: "#7e57c2" } },
      ],
    },
  ]);
  stop();
  expect(saved.at(-1)?.customThemes.map((t) => [t.id, t.name, t.variants.map((v) => [v.id, v.name])])).toEqual([
    [
      "custom-ext",
      "Night Owl",
      [
        ["custom-ext-0", "Night Owl"],
        ["custom-ext-1", "Light Owl"],
        ["custom-ext-2", "Night Owl (No Italics)"],
      ],
    ],
  ]);
  expect(saved.at(-1)).toMatchObject({ colorScheme: "System", lightTheme: "custom-ext-1", darkTheme: "custom-ext-0" });
});

it("picks one light and one dark when a family's name is clicked, however many variants it has", async () => {
  const { saved, stop } = paintAndRecordSaves();
  const family = customFamily(catppuccin);
  await chooseThemes(family ? familyPicks(family) : []);
  stop();
  expect(saved.at(-1)).toEqual({ ...initial.settings, lightTheme: "custom-cat-0", darkTheme: "custom-cat-1" });
});

it("deletes a whole family and resets a slot that held any of its variants", async () => {
  const { saved, stop } = paintAndRecordSaves();
  useWorkspace.setState({ settings: { ...initial.settings, lightTheme: "custom-cat-0", darkTheme: "custom-cat-2", customThemes: [catppuccin] } });
  await deleteCustomTheme("custom-cat");
  stop();
  expect(saved.at(-1)).toEqual({ ...initial.settings, lightTheme: "l1-light", darkTheme: "l1-dark", customThemes: [] });
});

const selectValue = (html: string, testId: string) => new RegExp(`data-testid="${testId}"[^>]*>(.*?)</select>`).exec(html)?.[1]?.match(/<option[^>]*selected=""[^>]*>([^<]*)</)?.[1];

it("shows the saved density, fonts, panel speed, and connection tint in the appearance cards", () => {
  const settings: Settings = {
    ...initial.settings,
    density: "Spacious",
    interfaceFont: { family: "System", size: 15 },
    codeFont: { family: "Berkeley Mono", size: 11 },
    panelMotionMs: 0,
    tintConnections: true,
  };
  const html = render({ ...settingsOpen(), settings });
  expect(radios(html, "density")).toEqual([
    ["Compact", false],
    ["Standard", false],
    ["Spacious", true],
  ]);
  expect([selectValue(html, "setting-interfaceFont-family"), selectValue(html, "setting-interfaceFont-size")]).toEqual(["System", "15 px"]);
  expect([selectValue(html, "setting-codeFont-family"), selectValue(html, "setting-codeFont-size")]).toEqual(["Berkeley Mono", "11 px"]);
  expect(html).toMatch(/data-testid="setting-panelMotion"[^>]*value="0"/);
  expect(html).toContain('data-testid="setting-panelMotion-reset"');
  expect(html).toMatch(/data-testid="setting-tintConnections"[^>]*checked/);
  const defaults = render({ ...settingsOpen(), settings: initial.settings });
  expect(defaults).not.toContain('data-testid="setting-panelMotion-reset"');
  expect(defaults).toMatch(/data-testid="setting-tintConnections"(?![^>]*checked)[^>]*>/);
});

it("saves the clicked density and repaints the spacing scale", async () => {
  const { root, saved, stop } = paintAndRecordSaves();
  const appearance = startAppearance();
  await chooseDensity("Compact");
  appearance();
  stop();
  expect(saved).toEqual([{ ...initial.settings, density: "Compact" }]);
  expect(root.style.vars.get("--density")).toBe("0.85");
});

it("changes only the size of the chosen font and keeps its family", async () => {
  const { saved, stop } = paintAndRecordSaves();
  await chooseFont("code", { size: 16 });
  await chooseFont("interface", { family: "System" });
  stop();
  expect(saved.map((s) => [s.codeFont, s.interfaceFont])).toEqual([
    [{ family: "JetBrains Mono", size: 16 }, initial.settings.interfaceFont],
    [{ family: "JetBrains Mono", size: 16 }, { family: "System", size: 13 }],
  ]);
});

it("repaints the panel speed while the slider moves and saves it once on release", async () => {
  const { root, saved, stop } = paintAndRecordSaves();
  const appearance = startAppearance();
  previewPanelMotion(250);
  previewPanelMotion(300);
  expect([saved, root.style.vars.get("--panel-duration")]).toEqual([[], "300ms"]);
  await savePanelMotion(300);
  appearance();
  stop();
  expect(saved).toEqual([{ ...initial.settings, panelMotionMs: 300 }]);
});

const CLAUDE: ProviderState = {
  provider: "Claude",
  rev: 4,
  info: {
    defaultName: "Claude",
    defaultBinary: "claude",
    configEnv: "CLAUDE_CONFIG_DIR",
    configDirDefault: "~/.claude",
    signInCommand: "claude auth login",
    ownedFlags: ["--model", "--resume"],
  },
  checking: false,
  checkedAtMs: Date.UTC(2026, 9, 16, 11, 57, 30),
  outcome: { kind: "Ready", version: "2.1.301", plan: "Claude Max", models: [] },
};

const byTestId = (html: string, id: string) => text(new RegExp(`data-testid="${id}"[^>]*>(.*?)</(?:span|p|button)>`).exec(html)?.[1]);
const inputTag = (html: string, id: string) => new RegExp(`<input[^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0] ?? "";
const resetTag = (html: string) => /<button[^>]*data-testid="provider-reset"[^>]*>/.exec(html)?.[0] ?? "";
const attr = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];

it("shows each provider's version, sign-in, and switch, and the picked provider's runtime fields with hints from the engine", () => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 16, 12, 0, 0) });
  const providers = [{ provider: "Claude", enabled: true, displayName: "Claude", binaryPath: "", configDir: "/opt/claude-work", launchArgs: "--model opus --verbose" }] as const;
  const html = render({ ...settingsOpen("providers"), settings: { ...initial.settings, providers: [...providers], providerHealthCheckSecs: 300 } }, { providers: { Claude: CLAUDE } });
  expect(breadcrumb(html)).toBe("Settings / Providers");
  expect([byTestId(html, "provider-version-Claude"), byTestId(html, "provider-status-Claude"), byTestId(html, "providers-checked")]).toEqual([
    "v2.1.301",
    "Signed in · Claude Max",
    "Checked 2m ago",
  ]);
  expect(html).toMatch(/role="switch" aria-checked="true" aria-label="Use Claude" data-testid="provider-toggle-Claude"/);
  expect(text(html)).toContain("Signed in with a Claude Max subscription.");
  expect(text(html)).toContain("Path to the claude binary L1 Data starts.");
  expect(text(html)).toContain("Where Claude keeps its login and settings. Sets CLAUDE_CONFIG_DIR.");
  expect(text(html)).toContain("Extra command-line arguments passed to claude when a chat starts.");
  expect(byTestId(html, "provider-launch-args-ignored")).toBe("Ignored: --model");
  expect(["provider-display-name", "provider-binary-path", "provider-config-dir", "provider-launch-args"].map((id) => [attr(inputTag(html, id), "value"), attr(inputTag(html, id), "placeholder")])).toEqual([
    ["Claude", "Claude"],
    ["", "claude"],
    ["/opt/claude-work", "~/.claude"],
    ["--model opus --verbose", "--model claude-opus-5-5"],
  ]);
  expect(attr(inputTag(html, "setting-providerHealthCheck"), "value")).toBe("300");
  expect(resetTag(html)).not.toContain('disabled=""');
});

it("says Checking while a probe runs and keeps the last outcome on the provider's row", () => {
  const html = render(settingsOpen("providers"), { providers: { Claude: { ...CLAUDE, checking: true, outcome: { kind: "NotFound", binary: "claude on PATH" } } } });
  expect([byTestId(html, "providers-checked"), byTestId(html, "provider-status-Claude")]).toEqual(["Checking…", "Not found"]);
  expect(html).not.toContain('data-testid="provider-version-Claude"');
  expect(resetTag(html)).toContain('disabled=""');
});

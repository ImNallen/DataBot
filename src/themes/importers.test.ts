import { expect, it } from "vitest";
import { asVsCodeTheme, mergeVsCodeThemes, parseThemeFile, vsCodeThemeToDraft } from "./importers";

// Trimmed from dracula-theme.theme-dracula 2.25.1 on Open VSX (MIT), keeping its JSONC trailing commas.
const DRACULA = `{
  "name": "Dracula",
  "colors": {
    "editor.background": "#282A36",
    "editor.foreground": "#F8F8F2",
    "foreground": "#F8F8F2",
    "sideBar.background": "#21222C",
    "activityBar.background": "#343746",
    "panel.background": "#282A36",
    "editorWidget.background": "#21222C",
    "list.hoverBackground": "#44475A75",
    "list.activeSelectionBackground": "#44475A",
    "panel.border": "#BD93F9",
    "editorGroup.border": "#BD93F9",
    "focusBorder": "#6272A4",
    "button.background": "#44475A",
    "activityBarBadge.background": "#FF79C6",
    "editor.selectionBackground": "#44475A",
    "editor.selectionHighlightBackground": "#424450",
    "editor.findMatchBackground": "#FFB86C80",
    "editor.findMatchHighlightBackground": "#FFFFFF40",
    "errorForeground": "#FF5555",
    "terminal.ansiGreen": "#50FA7B",
    "terminal.ansiYellow": "#F1FA8C",
  },
  "tokenColors": [
    {"scope": ["comment", "punctuation.definition.comment", "unused.comment", "wildcard.comment"], "settings": {"foreground": "#6272A4"}},
    {"scope": ["keyword", "punctuation.definition.keyword"], "settings": {"foreground": "#FF79C6"}},
    {"scope": ["string"], "settings": {"foreground": "#F1FA8C"}},
  ],
}`;

it("maps a VS Code theme onto L1 tokens, flattening translucent surfaces onto the background", () => {
  const result = parseThemeFile(DRACULA, "dracula.json");
  expect(result).toEqual({
    ok: true,
    family: {
      name: "Dracula",
      variants: [
        {
          name: "Dracula",
          appearance: "dark",
          colors: {
            background: "#282a36",
            foreground: "#f8f8f2",
            code: "#f8f8f2",
            sidebar: "#21222c",
            results: "#282a36",
            raised: "#21222c",
            hover: "#353747",
            selected: "#44475a",
            accent: "#ff79c6",
            focus: "#6272a4",
            danger: "#ff5555",
            live: "#50fa7b",
            keyword: "#ff79c6",
            green: "#f1fa8c",
            amber: "#f1fa8c",
            dim: "#6272a4",
            codeSelection: "#44475a",
            codeSelectionMatch: "#424450",
            codeSearchMatch: "#ffffff40",
            codeSearchCurrent: "#ffb86c80",
          },
        },
      ],
    },
  });
});

it("takes the appearance from the manifest's uiTheme, then the theme's type, then the background", () => {
  const theme = asVsCodeTheme({ colors: { "editor.background": "#1e1e1e" } });
  expect(theme && [vsCodeThemeToDraft(theme, "x", "vs").appearance, vsCodeThemeToDraft(theme, "x").appearance]).toEqual(["light", "dark"]);
  expect(parseThemeFile('{ "type": "light", "colors": { "editor.background": "#000000" } }')).toMatchObject({ ok: true, family: { variants: [{ appearance: "light" }] } });
  expect(parseThemeFile('{ "colors": { "editor.background": "#fdf6e3" } }', "solarized-light.json")).toMatchObject({
    ok: true,
    family: { name: "solarized-light", variants: [{ name: "solarized-light", appearance: "light", colors: { background: "#fdf6e3", accent: "#346bf1" } }] },
  });
});

it("lets an including theme override the colours it includes", () => {
  const parent = asVsCodeTheme({ name: "Base", colors: { "editor.background": "#101010", "button.background": "#ff0000" } });
  const child = asVsCodeTheme({ name: "Child", include: "./base.json", colors: { "button.background": "#00ff00" } });
  const merged = parent && child && vsCodeThemeToDraft(mergeVsCodeThemes(parent, child), "x");
  expect(merged).toMatchObject({ name: "Child", colors: { background: "#101010", accent: "#00ff00" } });
});

it("reads an L1 theme, dropping unknown keys and flattening alpha on opaque tokens", () => {
  const text = JSON.stringify({
    version: 1,
    name: " Aurora ",
    appearance: "light",
    colors: { background: "#ffffff", accent: "#7c3aed", sidebar: "#00000080", codeSearchMatch: "#ffcc0040", sparkle: "#123456", muted: "grey" },
  });
  expect(parseThemeFile(text)).toEqual({
    ok: true,
    family: {
      name: "Aurora",
      variants: [{ name: "Aurora", appearance: "light", colors: { background: "#ffffff", accent: "#7c3aed", sidebar: "#7f7f7f", codeSearchMatch: "#ffcc0040" } }],
    },
  });
});

it.each([
  ["{ \"colors\": { ", "Invalid JSON on line 1: CloseBraceExpected."],
  ['{\n  "version": 1,\n  "name": }', "Invalid JSON on line 3: ValueExpected."],
  ["[1, 2]", "Not a theme: expected an L1 theme or a VS Code color theme."],
  ['{ "hello": "world" }', "Not a theme: expected an L1 theme or a VS Code color theme."],
  ['{ "version": 2, "name": "A", "appearance": "dark", "colors": {} }', "Unsupported theme version; expected 1."],
  ['{ "version": 1, "name": "", "appearance": "dark", "colors": {} }', "The theme needs a name."],
  ['{ "version": 1, "name": "A", "appearance": "dim", "colors": {} }', 'appearance must be "light" or "dark".'],
  ['{ "version": 1, "name": "A", "appearance": "dark", "colors": { "background": "#000" } }', "colors.background and colors.accent must be hex colours."],
])("rejects %s", (text, error) => {
  expect(parseThemeFile(text)).toEqual({ ok: false, error });
});

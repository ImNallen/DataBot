import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { Appearance } from "../ipc/bindings";
import { L1_VARIANTS, type ThemeDraft, type ThemeFamilyDraft } from "./catalog";
import { chroma, formatHex, isDark, over, parseHex } from "./color";
import { isToken, type Palette, type Token } from "./palette";

export type ImportResult = { ok: true; family: ThemeFamilyDraft } | { ok: false; error: string };

const single = (draft: ThemeDraft): ImportResult => ({ ok: true, family: { name: draft.name, variants: [draft] } });

type Json = { [key: string]: unknown };

export const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Parses JSON with comments and trailing commas, as VS Code theme files are written. */
export function readJsonc(text: string): Parsed<unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  const first = errors[0];
  if (!first) return { ok: true, value };
  const line = text.slice(0, first.offset).split("\n").length;
  return { ok: false, error: `Invalid JSON on line ${line}: ${printParseErrorCode(first.error)}.` };
}

// Overlay tokens are painted over other colours, so they keep their alpha; every other token is opaque.
const TRANSLUCENT = new Set<Token>(["codeSelectionMatch", "codeSearchMatch", "codeSearchCurrent", "codeExecuted"]);

function tokenColor(token: Token, value: unknown, background: string): string | null {
  const color = typeof value === "string" ? parseHex(value) : null;
  if (!color) return null;
  if (color.a === 1 || TRANSLUCENT.has(token)) return formatHex(color);
  const bg = parseHex(background);
  return bg ? formatHex(over(color, bg)) : formatHex({ ...color, a: 1 });
}

function l1Theme(raw: Json): ImportResult {
  const { name, appearance, colors } = raw;
  if (raw.version !== 1) return { ok: false, error: "Unsupported theme version; expected 1." };
  if (typeof name !== "string" || !name.trim()) return { ok: false, error: "The theme needs a name." };
  if (appearance !== "light" && appearance !== "dark") return { ok: false, error: 'appearance must be "light" or "dark".' };
  if (!isObject(colors)) return { ok: false, error: "The theme needs a colors object." };
  const background = tokenColor("background", colors.background, "#000000");
  const accent = background && tokenColor("accent", colors.accent, background);
  if (!background || !accent) return { ok: false, error: "colors.background and colors.accent must be hex colours." };
  const palette: Palette = {};
  for (const [key, value] of Object.entries(colors)) {
    const color = isToken(key) ? tokenColor(key, value, background) : null;
    if (isToken(key) && color) palette[key] = color;
  }
  return single({ name: name.trim(), appearance, colors: { ...palette, background, accent } });
}

export type VsCodeTheme = { name?: string; type?: string; include?: string; colors: Record<string, string>; tokenColors: TokenRule[] };
type TokenRule = { scopes: string[]; foreground: string };

export function asVsCodeTheme(raw: unknown): VsCodeTheme | null {
  if (!isObject(raw) || !(isObject(raw.colors) || Array.isArray(raw.tokenColors) || typeof raw.include === "string")) return null;
  const colors: Record<string, string> = {};
  for (const [key, value] of Object.entries(isObject(raw.colors) ? raw.colors : {})) if (typeof value === "string") colors[key] = value;
  const tokenColors = (Array.isArray(raw.tokenColors) ? raw.tokenColors : []).flatMap((rule): TokenRule[] => {
    if (!isObject(rule) || !isObject(rule.settings) || typeof rule.settings.foreground !== "string") return [];
    const scope = rule.scope;
    const scopes = typeof scope === "string" ? scope.split(",") : Array.isArray(scope) ? scope.filter((s): s is string => typeof s === "string") : [];
    return [{ scopes: scopes.map((s) => s.trim()), foreground: rule.settings.foreground }];
  });
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  return { name: text(raw.name), type: text(raw.type), include: text(raw.include), colors, tokenColors };
}

/** `child` over the theme it includes, as VS Code resolves `include`. */
export function mergeVsCodeThemes(parent: VsCodeTheme, child: VsCodeTheme): VsCodeTheme {
  return {
    name: child.name ?? parent.name,
    type: child.type ?? parent.type,
    colors: { ...parent.colors, ...child.colors },
    tokenColors: [...parent.tokenColors, ...child.tokenColors],
  };
}

type Source = { keys: readonly string[]; scopes?: readonly string[]; pick?: "colorful" | "neutral" };

// The first colour a theme sets wins; `scopes` are TextMate scopes tried before workbench `keys`.
// `colorful` prefers a coloured candidate over a grey one; `neutral` takes greys only, so loud borders fall back to derived ones.
const VS_CODE_SOURCES: Partial<Record<Token, Source>> = {
  background: { keys: ["editor.background"] },
  foreground: { keys: ["editor.foreground", "foreground"] },
  sidebar: { keys: ["sideBar.background", "activityBar.background"] },
  raised: { keys: ["editorWidget.background", "dropdown.background", "menu.background"] },
  hover: { keys: ["list.hoverBackground"] },
  selected: { keys: ["list.activeSelectionBackground", "list.inactiveSelectionBackground"] },
  border: { keys: ["sideBar.border", "editorGroup.border", "panel.border"], pick: "neutral" },
  tree: { keys: ["sideBar.foreground"] },
  accent: {
    keys: [
      "button.background",
      "focusBorder",
      "textLink.foreground",
      "activityBarBadge.background",
      "progressBar.background",
      "panelTitle.activeBorder",
      "inputOption.activeBorder",
      "tab.activeBorder",
    ],
    pick: "colorful",
  },
  focus: { keys: ["focusBorder"] },
  danger: { keys: ["errorForeground", "editorError.foreground"] },
  live: { keys: ["terminal.ansiGreen"] },
  keyword: { scopes: ["keyword", "storage.type", "storage"], keys: [] },
  green: { scopes: ["string"], keys: ["terminal.ansiGreen"] },
  amber: { scopes: ["constant.numeric", "constant"], keys: ["terminal.ansiYellow"] },
  dim: { scopes: ["comment"], keys: [] },
  code: { keys: ["editor.foreground"] },
  codeSelection: { keys: ["editor.selectionBackground"] },
  codeSelectionMatch: { keys: ["editor.selectionHighlightBackground"] },
  codeSearchMatch: { keys: ["editor.findMatchHighlightBackground"] },
  codeSearchCurrent: { keys: ["editor.findMatchBackground"] },
  codeBracket: { keys: ["editorBracketMatch.background"] },
  scrollbar: { keys: ["scrollbarSlider.background"] },
  scrollbarHover: { keys: ["scrollbarSlider.hoverBackground"] },
};

const isColorful = (hex: string) => chroma(hex) >= 0.1;

function candidates(theme: VsCodeTheme, source: Source): string[] {
  const scoped = (source.scopes ?? []).flatMap((scope) => theme.tokenColors.findLast((r) => r.scopes.includes(scope))?.foreground ?? []);
  const keyed = source.keys.flatMap((k) => theme.colors[k] ?? []);
  return [...scoped, ...keyed].filter((c) => parseHex(c) !== null);
}

const UI_THEME_APPEARANCE: Record<string, Appearance> = {
  vs: "light",
  light: "light",
  "hc-light": "light",
  hcLight: "light",
  "vs-dark": "dark",
  dark: "dark",
  "hc-black": "dark",
  hc: "dark",
};

/** Maps a VS Code colour theme onto L1's tokens; `uiTheme` is the extension manifest's base theme, when known. */
export function vsCodeThemeToDraft(theme: VsCodeTheme, fallbackName: string, uiTheme?: string): ThemeDraft {
  const pick = (token: Token): string | undefined => {
    const source = VS_CODE_SOURCES[token];
    if (!source) return undefined;
    const found = candidates(theme, source);
    switch (source.pick) {
      case undefined:
        return found[0];
      case "colorful":
        return found.find(isColorful) ?? found[0];
      case "neutral":
        return found.find((c) => chroma(c) < 0.06);
      default: {
        const unreachable: never = source.pick;
        return unreachable;
      }
    }
  };
  const rawBackground = pick("background");
  const appearance =
    UI_THEME_APPEARANCE[uiTheme ?? ""] ?? UI_THEME_APPEARANCE[theme.type ?? ""] ?? (rawBackground && !isDark(rawBackground) ? "light" : "dark");
  const fallback = L1_VARIANTS[appearance].swatch;
  const background = tokenColor("background", rawBackground, "#000000") ?? fallback.background;
  const palette: Palette = {};
  for (const key of Object.keys(VS_CODE_SOURCES)) {
    const color = isToken(key) ? tokenColor(key, pick(key), background) : null;
    if (isToken(key) && color) palette[key] = color;
  }
  return { name: theme.name?.trim() || fallbackName, appearance, colors: { ...palette, background, accent: palette.accent ?? fallback.accent } };
}

const baseName = (fileName?: string) => fileName?.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "") || "Imported theme";

/** Reads an L1 theme or a VS Code colour theme. VS Code `include`s can't be followed from a lone file. */
export function parseThemeFile(text: string, fileName?: string): ImportResult {
  const json = readJsonc(text);
  if (!json.ok) return json;
  if (isObject(json.value) && "version" in json.value) return l1Theme(json.value);
  const theme = asVsCodeTheme(json.value);
  if (!theme) return { ok: false, error: "Not a theme: expected an L1 theme or a VS Code color theme." };
  return single(vsCodeThemeToDraft(theme, baseName(fileName)));
}

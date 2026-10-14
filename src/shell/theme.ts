import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useWorkspace } from "../state/workspace";
import { FIXED_APPEARANCE, resolveTheme, type ThemeSettings, type ThemeVariant } from "../themes/catalog";
import { isToken, TOKENS, type Token } from "../themes/palette";

let preview: ThemeVariant | null = null;
const previewListeners = new Set<() => void>();

/** Paints `variant` over the saved theme until called with null. */
export function previewTheme(variant: ThemeVariant | null): void {
  preview = variant;
  for (const fn of previewListeners) fn();
}

const themeChanged = (s: ThemeSettings, prev: ThemeSettings) =>
  s.colorScheme !== prev.colorScheme || s.lightTheme !== prev.lightTheme || s.darkTheme !== prev.darkTheme || s.customThemes !== prev.customThemes;

export function startTheme(): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const log = (e: unknown) => console.error("window theme sync failed", e);
  let painted: Token[] = [];
  const paint = () => {
    const variant = preview ?? resolveTheme(useWorkspace.getState().settings, media.matches);
    const root = document.documentElement;
    root.dataset.theme = variant.appearance;
    root.style.colorScheme = variant.appearance;
    for (const token of painted) root.style.removeProperty(TOKENS[token]);
    painted = [];
    for (const [token, value] of Object.entries(variant.palette)) {
      if (!isToken(token) || !value) continue;
      root.style.setProperty(TOKENS[token], value);
      painted.push(token);
    }
  };
  let latest = 0;
  // In the app window the webview reports the window's forced theme, so paint only once the window has the new one.
  const apply = async () => {
    if (!isTauri()) return paint();
    const request = ++latest;
    const win = getCurrentWindow();
    await win.setTheme(FIXED_APPEARANCE[useWorkspace.getState().settings.colorScheme]).catch(log);
    if (request !== latest) return;
    paint();
    const background = getComputedStyle(document.documentElement).getPropertyValue("--color-bg").trim();
    await win.setBackgroundColor(background).catch(log);
  };
  const onChange = () => void apply();
  const unsubscribe = useWorkspace.subscribe((s, prev) => {
    if (themeChanged(s.settings, prev.settings)) onChange();
  });
  media.addEventListener("change", onChange);
  previewListeners.add(onChange);
  // main.rs opened the window with the saved scheme, so the first paint can trust the webview right away.
  paint();
  onChange();
  return () => {
    unsubscribe();
    media.removeEventListener("change", onChange);
    previewListeners.delete(onChange);
  };
}

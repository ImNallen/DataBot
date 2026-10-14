import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Theme } from "../ipc/bindings";
import { useWorkspace } from "../state/workspace";

export type Appearance = "light" | "dark";

export function resolveTheme(pref: Theme, systemPrefersDark: boolean): Appearance {
  switch (pref) {
    case "System":
      return systemPrefersDark ? "dark" : "light";
    case "Light":
      return "light";
    case "Dark":
      return "dark";
    default: {
      const unreachable: never = pref;
      return unreachable;
    }
  }
}

const NATIVE_THEME: Record<Theme, Appearance | null> = { System: null, Light: "light", Dark: "dark" };

export function startTheme(): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const log = (e: unknown) => console.error("window theme sync failed", e);
  const paint = (pref: Theme) => {
    const appearance = resolveTheme(pref, media.matches);
    const root = document.documentElement;
    root.dataset.theme = appearance;
    root.style.colorScheme = appearance;
  };
  let latest = 0;
  // In the app window the webview reports the window's forced theme, so paint only once the window has the new one.
  const apply = async () => {
    const pref = useWorkspace.getState().settings.theme;
    if (!isTauri()) return paint(pref);
    const request = ++latest;
    const win = getCurrentWindow();
    await win.setTheme(NATIVE_THEME[pref]).catch(log);
    if (request !== latest) return;
    paint(pref);
    const background = getComputedStyle(document.documentElement).getPropertyValue("--color-bg").trim();
    await win.setBackgroundColor(background).catch(log);
  };
  const onChange = () => void apply();
  const unsubscribe = useWorkspace.subscribe((s, prev) => {
    if (s.settings.theme !== prev.settings.theme) onChange();
  });
  media.addEventListener("change", onChange);
  // main.rs opened the window with the saved theme, so the first paint can trust the webview right away.
  paint(useWorkspace.getState().settings.theme);
  onChange();
  return () => {
    unsubscribe();
    media.removeEventListener("change", onChange);
  };
}

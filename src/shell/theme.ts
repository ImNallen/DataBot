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

function syncWindow(pref: Theme) {
  const win = getCurrentWindow();
  const background = getComputedStyle(document.documentElement).getPropertyValue("--color-bg").trim();
  const log = (e: unknown) => console.error("window theme sync failed", e);
  win.setTheme(NATIVE_THEME[pref]).catch(log);
  win.setBackgroundColor(background).catch(log);
}

export function startTheme(): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    const pref = useWorkspace.getState().settings.theme;
    const appearance = resolveTheme(pref, media.matches);
    const root = document.documentElement;
    root.dataset.theme = appearance;
    root.style.colorScheme = appearance;
    if (isTauri()) syncWindow(pref);
  };
  const unsubscribe = useWorkspace.subscribe((s, prev) => {
    if (s.settings.theme !== prev.settings.theme) apply();
  });
  media.addEventListener("change", apply);
  apply();
  return () => {
    unsubscribe();
    media.removeEventListener("change", apply);
  };
}

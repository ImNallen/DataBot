import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Theme } from "../ipc/bindings";
import { useWorkspace } from "../state/workspace";
import { resolveTheme, startTheme } from "./theme";

it.each([
  ["System", true, "dark"],
  ["System", false, "light"],
  ["Light", true, "light"],
  ["Light", false, "light"],
  ["Dark", true, "dark"],
  ["Dark", false, "dark"],
] as const)("resolves %s with a %s dark system preference to %s", (pref, systemDark, expected) => {
  expect(resolveTheme(pref, systemDark)).toBe(expected);
});

let root: { dataset: Record<string, string>; style: Record<string, string> };
let system: { matches: boolean; listeners: (() => void)[] };

beforeEach(() => {
  root = { dataset: {}, style: {} };
  system = { matches: true, listeners: [] };
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("window", {
    matchMedia: () => ({
      get matches() {
        return system.matches;
      },
      addEventListener: (_: string, fn: () => void) => system.listeners.push(fn),
      removeEventListener: (_: string, fn: () => void) => system.listeners.splice(system.listeners.indexOf(fn), 1),
    }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useWorkspace.setState(useWorkspace.getInitialState(), true);
});

const setTheme = (theme: Theme) => useWorkspace.setState({ settings: { ...useWorkspace.getState().settings, theme } });
const setSystemDark = (dark: boolean) => {
  system.matches = dark;
  for (const fn of system.listeners) fn();
};

it("paints the document with the chosen theme and follows the system only while the choice is System", () => {
  const stop = startTheme();
  expect([root.dataset.theme, root.style.colorScheme]).toEqual(["dark", "dark"]);

  setSystemDark(false);
  expect([root.dataset.theme, root.style.colorScheme]).toEqual(["light", "light"]);

  setTheme("Dark");
  expect(root.dataset.theme).toBe("dark");
  setSystemDark(true);
  setSystemDark(false);
  expect(root.dataset.theme).toBe("dark");

  setTheme("Light");
  setSystemDark(true);
  expect(root.dataset.theme).toBe("light");

  setTheme("System");
  expect(root.dataset.theme).toBe("dark");

  stop();
  setTheme("Light");
  expect(root.dataset.theme).toBe("dark");
});

// The webview reports the window's forced theme until set_theme lands, then the OS appearance, which is dark here.
function inTauriWindow(delays: Record<string, number> = {}) {
  vi.stubGlobal("isTauri", true);
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "#000" }));
  mockWindows("main");
  mockIPC((cmd, args) => {
    if (cmd !== "plugin:window|set_theme") return null;
    const forced = (args as { value: "light" | "dark" | null }).value;
    return new Promise((resolve) =>
      setTimeout(() => {
        const dark = forced === null ? true : forced === "dark";
        if (dark !== system.matches) setSystemDark(dark);
        resolve(null);
      }, delays[String(forced)] ?? 5),
    );
  });
  const painted: string[] = [];
  root.dataset = new Proxy(root.dataset, {
    set(target, key, value) {
      if (key === "theme") painted.push(value);
      target[key as string] = value;
      return true;
    },
  });
  return painted;
}

const settle = () => new Promise((r) => setTimeout(r, 50));

it("in the app window, paints System from the OS only after the window drops its forced theme", async () => {
  const painted = inTauriWindow();
  setTheme("Light");
  system.matches = false;
  const stop = startTheme();
  await settle();
  painted.length = 0;

  setTheme("System");
  await settle();
  stop();
  expect(painted).not.toContain("light");
  expect(painted.at(-1)).toBe("dark");
});

it("in the app window, never paints an earlier choice whose window theme change lands last", async () => {
  const painted = inTauriWindow({ light: 30, dark: 5 });
  const stop = startTheme();
  await settle();
  painted.length = 0;

  setTheme("Light");
  setTheme("Dark");
  await settle();
  stop();
  expect(painted).not.toContain("light");
  expect(painted.at(-1)).toBe("dark");
});

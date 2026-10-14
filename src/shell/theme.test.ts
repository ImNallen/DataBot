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

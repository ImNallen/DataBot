import { afterEach, expect, it } from "vitest";
import { useWorkspace } from "../state/workspace";
import { commandForKey } from "./commands";

const press = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>> = { metaKey: true }) =>
  commandForKey({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

afterEach(() => useWorkspace.setState(useWorkspace.getInitialState(), true));

it("maps each shortcut to its command, with Ctrl standing in for Cmd", () => {
  expect(["t", "n", "p", ",", "w"].map((k) => press(k)?.id)).toEqual(["new-query", "new-connection", "search", "settings", "close-tab"]);
  expect(press("T", { ctrlKey: true })?.id).toBe("new-query");
});

it("ignores plain keys and shifted or alt chords", () => {
  expect(press("t", {})).toBeUndefined();
  expect(press("t", { metaKey: true, shiftKey: true })).toBeUndefined();
  expect(press("p", { metaKey: true, altKey: true })).toBeUndefined();
  expect(press("k")).toBeUndefined();
});

it("opens the overlay each command names", () => {
  press("n")?.run();
  expect(useWorkspace.getState().overlay).toEqual({ kind: "connection", editing: null });
  press("p")?.run();
  expect(useWorkspace.getState().overlay).toEqual({ kind: "palette" });
});

it("toggles the settings screen on its shortcut, starting at Appearance", () => {
  press(",")?.run();
  expect(useWorkspace.getState().screen).toEqual({ kind: "settings", section: "appearance" });
  press(",")?.run();
  expect(useWorkspace.getState().screen).toEqual({ kind: "workspace" });
});

it("leaves settings for the workspace before a shortcut opens an overlay there", () => {
  useWorkspace.getState().openSettings("queries");
  press("n")?.run();
  expect([useWorkspace.getState().screen, useWorkspace.getState().overlay]).toEqual([{ kind: "workspace" }, { kind: "connection", editing: null }]);
});

it("searches settings, not the catalog, while settings is open", () => {
  useWorkspace.getState().openSettings("queries");
  press("p")?.run();
  expect([useWorkspace.getState().screen, useWorkspace.getState().overlay]).toEqual([
    { kind: "settings", section: "queries" },
    { kind: "settings-search" },
  ]);
});

it("closes settings, not the active tab, on the close-tab shortcut", () => {
  useWorkspace.getState().addTab({ kind: "sql", id: "t1", title: "a.sql", console: { db: null, mode: "AutoCommit" } });
  useWorkspace.getState().openSettings();
  press("w")?.run();
  expect([useWorkspace.getState().screen, useWorkspace.getState().order]).toEqual([{ kind: "workspace" }, ["t1"]]);
});

const screenAndOverlay = () => [useWorkspace.getState().screen, useWorkspace.getState().overlay];

it.each(["w", ",", "t"])("closes the settings search along with settings on ⌘%s", (key) => {
  useWorkspace.getState().openSettings("queries");
  useWorkspace.getState().open({ kind: "settings-search" });
  press(key)?.run();
  expect(screenAndOverlay()).toEqual([{ kind: "workspace" }, { kind: "none" }]);
});

it.each([{ kind: "palette" }, { kind: "history" }] as const)("closes the $kind overlay when ⌘, opens settings", (overlay) => {
  useWorkspace.getState().open(overlay);
  press(",")?.run();
  expect(screenAndOverlay()).toEqual([{ kind: "settings", section: "appearance" }, { kind: "none" }]);
});

it.each([
  ["p", { kind: "palette" }],
  ["n", { kind: "connection", editing: null }],
] as const)("still opens its overlay on the workspace when ⌘%s leaves settings with the settings search open", (key, overlay) => {
  useWorkspace.getState().openSettings();
  useWorkspace.getState().open({ kind: "settings-search" });
  useWorkspace.getState().closeSettings();
  press(key)?.run();
  expect(screenAndOverlay()).toEqual([{ kind: "workspace" }, overlay]);
});

it("lands on the chosen setting with no overlay after a settings search pick", () => {
  useWorkspace.getState().openSettings();
  useWorkspace.getState().open({ kind: "settings-search" });
  useWorkspace.getState().close();
  useWorkspace.getState().openSettings("queries", "maxRows");
  expect(screenAndOverlay()).toEqual([{ kind: "settings", section: "queries", target: "maxRows" }, { kind: "none" }]);
});

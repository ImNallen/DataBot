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
  press("p")?.run();
  expect([useWorkspace.getState().screen, useWorkspace.getState().overlay]).toEqual([{ kind: "workspace" }, { kind: "palette" }]);
});

it("closes settings, not the active tab, on the close-tab shortcut", () => {
  useWorkspace.getState().addTab({ kind: "sql", id: "t1", title: "a.sql", console: { connectionId: null, schema: null, mode: "AutoCommit" } });
  useWorkspace.getState().openSettings();
  press("w")?.run();
  expect([useWorkspace.getState().screen, useWorkspace.getState().order]).toEqual([{ kind: "workspace" }, ["t1"]]);
});

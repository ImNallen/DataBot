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

it("opens the overlay a command names", () => {
  press("n")?.run();
  expect(useWorkspace.getState().overlay).toEqual({ kind: "connection", editing: null });
});

const searchState = () => {
  const { screen, overlay, layout, searchFocus } = useWorkspace.getState();
  return { screen, overlay, sidebar: layout.sidebar, searchFocus };
};

it("asks the sidebar search box for focus on ⌘P, closing any overlay so the box can take it", () => {
  useWorkspace.getState().open({ kind: "history" });
  press("p")?.run();
  expect(searchState()).toEqual({ screen: { kind: "workspace" }, overlay: { kind: "none" }, sidebar: true, searchFocus: true });
  useWorkspace.getState().searchFocused();
  expect(useWorkspace.getState().searchFocus).toBe(false);
});

it("reveals a hidden sidebar on ⌘P so its search box can mount and take focus", () => {
  useWorkspace.getState().setLayout({ sidebar: false });
  press("p")?.run();
  expect(searchState()).toEqual({ screen: { kind: "workspace" }, overlay: { kind: "none" }, sidebar: true, searchFocus: true });
});

it("stays on settings on ⌘P there and focuses the settings search box", () => {
  useWorkspace.getState().openSettings("queries");
  useWorkspace.getState().setSettingsQuery("row");
  press("p")?.run();
  expect(searchState()).toEqual({ screen: { kind: "settings", section: "queries", query: "row" }, overlay: { kind: "none" }, sidebar: true, searchFocus: true });
});

it("toggles the settings screen on its shortcut, starting at Appearance", () => {
  press(",")?.run();
  expect(useWorkspace.getState().screen).toEqual({ kind: "settings", section: "appearance", query: "" });
  press(",")?.run();
  expect(useWorkspace.getState().screen).toEqual({ kind: "workspace" });
});

it("leaves settings for the workspace before a shortcut opens an overlay there", () => {
  useWorkspace.getState().openSettings("queries");
  press("n")?.run();
  expect([useWorkspace.getState().screen, useWorkspace.getState().overlay]).toEqual([{ kind: "workspace" }, { kind: "connection", editing: null }]);
});

it("closes settings, not the active tab, on the close-tab shortcut", () => {
  useWorkspace.getState().addTab({ id: "t1", title: "a.sql", console: { db: null, mode: "AutoCommit" }, table: null });
  useWorkspace.getState().openSettings();
  press("w")?.run();
  expect([useWorkspace.getState().screen, useWorkspace.getState().order]).toEqual([{ kind: "workspace" }, ["t1"]]);
});

it.each(["w", ",", "t"])("drops the settings search when ⌘%s leaves settings, and keeps the tree search", (key) => {
  useWorkspace.getState().setTreeQuery("order");
  useWorkspace.getState().openSettings("queries");
  useWorkspace.getState().setSettingsQuery("row");
  press(key)?.run();
  press(",")?.run();
  expect([useWorkspace.getState().screen, useWorkspace.getState().treeQuery]).toEqual([{ kind: "settings", section: "appearance", query: "" }, "order"]);
});

it("closes an open overlay when ⌘, opens settings", () => {
  useWorkspace.getState().open({ kind: "history" });
  press(",")?.run();
  expect([useWorkspace.getState().screen, useWorkspace.getState().overlay]).toEqual([{ kind: "settings", section: "appearance", query: "" }, { kind: "none" }]);
});

it("opens a section with a blank search when its nav entry is picked from the results", () => {
  useWorkspace.getState().openSettings("appearance");
  useWorkspace.getState().setSettingsQuery("row limit");
  useWorkspace.getState().openSettings("queries");
  expect(useWorkspace.getState().screen).toEqual({ kind: "settings", section: "queries", query: "" });
});

it("keeps a settings search out of the workspace screen", () => {
  useWorkspace.getState().setSettingsQuery("row");
  expect([useWorkspace.getState().screen, useWorkspace.getState().treeQuery]).toEqual([{ kind: "workspace" }, ""]);
});

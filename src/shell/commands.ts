import { closeTab, openSqlTab } from "../features/editor/runActions";
import { useWorkspace, type Overlay } from "../state/workspace";

export type Command = { id: string; label: string; key: string; run: () => void };

const ws = () => useWorkspace.getState();

const inWorkspace = (run: () => void) => () => {
  ws().closeSettings();
  run();
};

const open = (overlay: Overlay) => inWorkspace(() => ws().open(overlay));

const searchCatalog = open({ kind: "palette" });

export const START_COMMANDS: Command[] = [
  { id: "new-query", label: "New query tab", key: "t", run: inWorkspace(() => openSqlTab()) },
  { id: "new-connection", label: "New connection", key: "n", run: open({ kind: "connection", editing: null }) },
  { id: "search", label: "Search", key: "p", run: () => (ws().screen.kind === "settings" ? ws().open({ kind: "settings-search" }) : searchCatalog()) },
  { id: "settings", label: "Settings", key: ",", run: () => (ws().screen.kind === "settings" ? ws().closeSettings() : ws().openSettings()) },
];

const CLOSE_TAB: Command = {
  id: "close-tab",
  label: "Close tab",
  key: "w",
  run: () => {
    const { screen, active, closeSettings } = ws();
    if (screen.kind === "settings") closeSettings();
    else if (active) void closeTab(active);
  },
};

const KEYMAP = [...START_COMMANDS, CLOSE_TAB];

export function commandForKey(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): Command | undefined {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return undefined;
  return KEYMAP.find((c) => c.key === e.key.toLowerCase());
}

export function shortcutLabel(c: Command): string {
  return `⌘${c.key.toUpperCase()}`;
}

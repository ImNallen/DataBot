import { closeTab, openSqlTab } from "../features/editor/runActions";
import { useWorkspace, type Overlay } from "../state/workspace";

export type Command = { id: string; label: string; key: string; run: () => void };

const open = (overlay: Overlay) => () => useWorkspace.getState().open(overlay);

export const START_COMMANDS: Command[] = [
  { id: "new-query", label: "New query tab", key: "t", run: () => openSqlTab() },
  { id: "new-connection", label: "New connection", key: "n", run: open({ kind: "connection", editing: null }) },
  { id: "search", label: "Search", key: "p", run: open({ kind: "palette" }) },
  { id: "settings", label: "Settings", key: ",", run: open({ kind: "settings" }) },
];

const CLOSE_TAB: Command = {
  id: "close-tab",
  label: "Close tab",
  key: "w",
  run: () => {
    const active = useWorkspace.getState().active;
    if (active) void closeTab(active);
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

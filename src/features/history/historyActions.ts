import type { HistoryGroupSummary } from "../../ipc/bindings";
import { useWorkspace } from "../../state/workspace";
import { focusEditor, insertAtCursor } from "../editor/editorStates";
import { openSqlTab, runActive } from "../editor/runActions";

export function openHistoryQuery(group: HistoryGroupSummary, sql: string, run = false) {
  openSqlTab({ db: { connectionId: group.connectionId, database: group.database }, text: sql, title: group.title });
  if (run) runActive({ kind: "all" });
}

export function insertHistoryQuery(sql: string): boolean {
  const state = useWorkspace.getState();
  if (!state.active || !state.tabs[state.active]) return false;
  insertAtCursor(state.active, sql);
  focusEditor();
  return true;
}

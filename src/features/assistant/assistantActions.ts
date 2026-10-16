import type { EditorState } from "@codemirror/state";
import {
  commands,
  type ApprovalId,
  type ChatId,
  type ChatOptions,
  type DatabaseRef,
  type Decision,
  type ResultRef,
  type RunState,
  type TabContext,
  type TabId,
} from "../../ipc/bindings";
import { approveErrorText, chatErrorText, sendErrorText } from "../../ipc/errors";
import { useLive } from "../../state/live";
import { resultView, type ResultPick, type RowResult } from "../../state/status";
import { needsResync } from "../../state/transcript";
import { useWorkspace, type Tab } from "../../state/workspace";
import { editorStateOf, focusEditor, insertAtCursor, replaceDoc } from "../editor/editorStates";
import { openSqlTab, runActive } from "../editor/runActions";

const ws = () => useWorkspace.getState();
const notify = (text: string) => ws().notify(text);

const opening = new Map<ChatId, Promise<void>>();

/** Loads the chat and every entry into the live store. A second call while one is in flight shares it. */
export function openChat(id: ChatId): Promise<void> {
  const inFlight = opening.get(id);
  if (inFlight) return inFlight;
  const open = commands
    .assistantOpen(id)
    .then((res) => {
      if (res.status === "error") return notify(chatErrorText(res.error));
      useLive.getState().hydrateChat(res.data);
    })
    .finally(() => opening.delete(id));
  opening.set(id, open);
  return open;
}

/** Puts `id` in the panel. The engine holds an unknown id as a draft until its first message. */
export function showChat(id: ChatId): Promise<void> {
  ws().setLayout({ assistantChat: id });
  return openChat(id);
}

export function newChat(): Promise<void> {
  return showChat(crypto.randomUUID());
}

/** The rows the tab's grid shows, which is what the attach button sends. Null while it shows output or nothing. */
export function gridResult(run: RunState | undefined, picked: ResultPick | undefined, hasOutput: boolean): RowResult | null {
  if (!run) return null;
  const view = resultView(run, picked, hasOutput);
  return view.kind === "rows" ? view.result : null;
}

function shownResultRef(tabId: TabId): ResultRef | null {
  const live = useLive.getState();
  return gridResult(live.consoles[tabId]?.run, ws().activeResult[tabId], (live.output[tabId]?.length ?? 0) > 0)?.meta.ref ?? null;
}

/** What the engine needs from the active tab. Offsets are CodeMirror's, which are UTF-16 code units, as `runTab` sends them. */
export function tabContext(tab: Tab, editor: EditorState, attach: ResultRef | null): TabContext {
  const sel = editor.selection.main;
  return {
    tabId: tab.id,
    title: tab.title,
    db: tab.console.db,
    text: editor.doc.toString(),
    target: sel.empty ? { kind: "cursor", offset: sel.head } : { kind: "selection", from: sel.from, to: sel.to },
    attach,
  };
}

/** True once the engine stored the message. The reply arrives as entry events. */
export async function sendMessage(chatId: ChatId, text: string, attach: boolean): Promise<boolean> {
  const { active, tabs } = ws();
  const tab = active ? tabs[active] : undefined;
  const context = tab ? tabContext(tab, editorStateOf(tab.id), attach ? shownResultRef(tab.id) : null) : null;
  const res = await commands.assistantSend(chatId, { text, tab: context });
  if (res.status === "error") {
    notify(sendErrorText(res.error));
    return false;
  }
  return true;
}

export function stopTurn(chatId: ChatId): void {
  void commands.assistantStop(chatId);
}

export async function answerApproval(chatId: ChatId, approval: ApprovalId, decision: Decision): Promise<void> {
  const res = await commands.assistantApprove(chatId, approval, decision);
  if (res.status === "error") notify(approveErrorText(res.error));
}

export async function configureChat(chatId: ChatId, options: ChatOptions): Promise<void> {
  const res = await commands.assistantConfigure(chatId, options);
  if (res.status === "error") return notify(chatErrorText(res.error));
  useLive.getState().hydrateChat({ state: res.data, entries: [] });
}

/** The engine publishes the tombstone; the panel moves to a new chat when the one it shows is deleted. */
export function deleteChat(chatId: ChatId): void {
  void commands.assistantDelete(chatId);
}

export function runInNewTab(sql: string, db: DatabaseRef | null): void {
  openSqlTab({ db, text: sql });
  runActive();
}

export function openInNewTab(sql: string, db: DatabaseRef | null): void {
  openSqlTab({ db, text: sql });
}

export function insertSql(sql: string): void {
  const id = ws().active;
  if (!id) return void openSqlTab({ text: sql });
  insertAtCursor(id, sql);
  focusEditor();
}

export function replaceTabSql(sql: string): void {
  const id = ws().active;
  if (!id) return void openSqlTab({ text: sql });
  replaceDoc(id, sql);
  focusEditor();
}

/** Reopens an opened chat once when it goes idle holding fewer entries than the engine reports, which means a lagged broadcast dropped one. */
export function startAssistantSync(): void {
  const reopenedAt = new Map<ChatId, number>();
  useLive.subscribe((s, prev) => {
    if (s.chats === prev.chats) return;
    for (const chat of Object.values(s.chats)) {
      if (chat === prev.chats[chat.id] || reopenedAt.get(chat.id) === chat.rev || !needsResync(chat, s.transcripts[chat.id])) continue;
      reopenedAt.set(chat.id, chat.rev);
      void openChat(chat.id);
    }
  });
}

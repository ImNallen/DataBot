import { undo } from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
import { mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, expect, it, vi } from "vitest";
import type { ConsoleState, ResultMeta, SendRequest } from "../../ipc/bindings";
import { useLive } from "../../state/live";
import { useWorkspace, type Tab } from "../../state/workspace";
import { dropEditor, editorStateOf, insertAtCursor, seedEditor, textOf } from "../editor/editorStates";
import { replaceTabSql, sendMessage, tabContext } from "./assistantActions";

afterEach(() => {
  vi.unstubAllGlobals();
  for (const id of useWorkspace.getState().order) dropEditor(id);
  useWorkspace.setState(useWorkspace.getInitialState(), true);
  useLive.setState(useLive.getInitialState(), true);
});

const TAB: Tab = { id: "tab-1", title: "orders_by_region.sql", console: { db: { connectionId: "c1", database: "shop" }, mode: "AutoCommit" }, table: null };

// "🦀" is two UTF-16 code units, so every offset past it is one more than its code point index.
const DOC = "-- 🦀 crab\nselect 1;\nselect 2;";

it("sends a selection as UTF-16 offsets into the tab's text, with the tab's database and title", () => {
  const editor = EditorState.create({ doc: DOC, selection: EditorSelection.single(21, 30) });
  expect(tabContext(TAB, editor, null)).toEqual({
    tabId: "tab-1",
    title: "orders_by_region.sql",
    db: { connectionId: "c1", database: "shop" },
    text: DOC,
    target: { kind: "selection", from: 21, to: 30 },
    attach: null,
  });
  expect(DOC.slice(21, 30)).toBe("select 2;");
});

it("sends a bare cursor as one UTF-16 offset", () => {
  const editor = EditorState.create({ doc: DOC, selection: EditorSelection.cursor(18) });
  expect(tabContext(TAB, editor, { tabId: "tab-1", runId: 4, index: 0 }).target).toEqual({ kind: "cursor", offset: 18 });
  expect(DOC.slice(11, 18)).toBe("select ");
});

const rows = (runId: number): ResultMeta => ({
  ref: { tabId: "tab-1", runId, index: 0 },
  db: { connectionId: "c1", database: "shop" },
  columns: [],
  rowCount: 6,
  rowsSeen: 6,
  truncated: null,
  elapsedMs: 27,
});

function showTab(text: string, live?: ConsoleState) {
  seedEditor(TAB.id, "");
  insertAtCursor(TAB.id, text);
  useWorkspace.setState({ tabs: { [TAB.id]: TAB }, order: [TAB.id], active: TAB.id });
  if (live) useLive.setState({ consoles: { [TAB.id]: live } });
}

function captureSend() {
  vi.stubGlobal("window", {});
  const sent: { chatId: string; request: SendRequest }[] = [];
  mockIPC((cmd, args) => {
    if (cmd !== "assistant_send") return;
    sent.push(args as { chatId: string; request: SendRequest });
    return { turn: 0 };
  });
  return sent;
}

it("sends the active tab's text, cursor, and the result its grid shows when attach is on", async () => {
  const sent = captureSend();
  const run: ConsoleState["run"] = { kind: "Finished", runId: 4, elapsedMs: 30, outcome: "Ok", statements: [{ index: 0, range: { from: 0, to: 9 }, status: { kind: "Rows", result: rows(4), done: true } }] };
  showTab(DOC, { tabId: TAB.id, rev: 3, config: { connectionId: "c1", database: "shop", schema: null, mode: "AutoCommit" }, session: { kind: "None" }, txn: "Idle", run });

  expect(await sendMessage("chat-1", "Which regions grew?", true)).toBe(true);
  expect(await sendMessage("chat-1", "And without it?", false)).toBe(true);
  expect(sent).toEqual([
    {
      chatId: "chat-1",
      request: {
        text: "Which regions grew?",
        tab: { tabId: "tab-1", title: "orders_by_region.sql", db: { connectionId: "c1", database: "shop" }, text: DOC, target: { kind: "cursor", offset: 30 }, attach: { tabId: "tab-1", runId: 4, index: 0 } },
      },
    },
    {
      chatId: "chat-1",
      request: {
        text: "And without it?",
        tab: { tabId: "tab-1", title: "orders_by_region.sql", db: { connectionId: "c1", database: "shop" }, text: DOC, target: { kind: "cursor", offset: 30 }, attach: null },
      },
    },
  ]);
});

it("sends no tab when none is open, and toasts the engine's refusal", async () => {
  vi.stubGlobal("window", {});
  const sent: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd !== "assistant_send") return;
    sent.push(args);
    throw { kind: "Busy" };
  });
  expect(await sendMessage("chat-1", "hello", true)).toBe(false);
  expect(sent).toEqual([{ chatId: "chat-1", request: { text: "hello", tab: null } }]);
  expect(useWorkspace.getState().toast?.text).toBe("The assistant is still answering. Stop it or wait for it to finish.");
});

it("replaces the active tab's SQL as one edit that a single undo reverts", () => {
  showTab("select 1;\n");
  insertAtCursor(TAB.id, "select 2;");
  replaceTabSql("SELECT region FROM customers;");
  expect(textOf(TAB.id)).toBe("SELECT region FROM customers;");
  let after = editorStateOf(TAB.id);
  undo({ state: after, dispatch: (tr) => void (after = tr.state) });
  expect(after.doc.toString()).toBe("select 1;\nselect 2;");
});

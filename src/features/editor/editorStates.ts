import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  ifNotIn,
  type Completion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { PostgreSQL, sql, type SQLNamespace } from "@codemirror/lang-sql";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, StateEffect, StateField, type Extension, type TransactionSpec } from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import type { DocRange, TabId } from "../../ipc/bindings";
import { editorHighlighting, editorTheme, functionCallStyle } from "./theme";

const states = new Map<TabId, EditorState>();
let view: EditorView | null = null;
let activeId: TabId | null = null;
let behavior: Extension = [];

const sqlConfig = new Compartment();

const flashEffect = StateEffect.define<DocRange[]>();
const clearFlash = StateEffect.define<null>();
const flashMark = Decoration.mark({ class: "cm-executed" });

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashEffect)) {
        const len = tr.state.doc.length;
        const ranges = e.value
          .map((r) => ({ from: Math.min(r.from, len), to: Math.min(r.to, len) }))
          .filter((r) => r.to > r.from)
          .map((r) => flashMark.range(r.from, r.to));
        next = Decoration.set(ranges, true);
      }
      if (e.is(clearFlash)) next = Decoration.none;
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function qualifiedTables(tables: readonly Completion[]): CompletionSource {
  return ifNotIn(["String", "QuotedIdentifier", "LineComment", "BlockComment"], (ctx) => {
    const word = ctx.matchBefore(/[\w$]+/);
    if (!word && !ctx.explicit) return null;
    const from = word?.from ?? ctx.pos;
    const isMemberAccess = ctx.state.sliceDoc(from - 1, from) === ".";
    if (isMemberAccess) return null;
    return { from, options: tables, validFor: /^[\w$]*$/ };
  });
}

function sqlLanguage(namespace: SQLNamespace | undefined, tables: readonly Completion[]): Extension {
  return [
    sql({ dialect: PostgreSQL, schema: namespace, upperCaseKeywords: true }),
    PostgreSQL.language.data.of({ autocomplete: qualifiedTables(tables) }),
  ];
}

export function installEditorBehavior(ext: Extension): void {
  behavior = ext;
}

function createState(text: string): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      behavior,
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ icons: false }),
      highlightSelectionMatches(),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
      sqlConfig.of(sqlLanguage(undefined, [])),
      flashField,
      editorTheme,
      editorHighlighting,
      functionCallStyle,
      EditorState.tabSize.of(2),
    ],
  });
}

export function seedEditor(id: TabId, text: string): void {
  states.set(id, createState(text));
}

export function setEditorText(id: TabId, text: string): void {
  updateEditor(id, (state) => ({ changes: { from: 0, to: state.doc.length, insert: text } }));
}

export function editorStateOf(id: TabId): EditorState {
  if (id === activeId && view) return view.state;
  let state = states.get(id);
  if (!state) {
    state = createState("");
    states.set(id, state);
  }
  return state;
}

export function textOf(id: TabId): string {
  return editorStateOf(id).doc.toString();
}

export function dropEditor(id: TabId): void {
  states.delete(id);
  if (activeId === id) activeId = null;
}

function updateEditor(id: TabId, spec: (state: EditorState) => TransactionSpec): void {
  if (id === activeId && view) {
    view.dispatch(spec(view.state));
    return;
  }
  const state = states.get(id);
  if (state) states.set(id, state.update(spec(state)).state);
}

export function mountEditor(parent: HTMLElement): () => void {
  if (!view) {
    view = new EditorView({
      state: activeId ? editorStateOf(activeId) : createState(""),
      dispatchTransactions(trs, v) {
        v.update(trs);
        if (activeId) states.set(activeId, v.state);
      },
    });
  }
  parent.appendChild(view.dom);
  view.requestMeasure();
  return () => view?.dom.remove();
}

export function activateEditor(id: TabId): void {
  if (activeId === id && view?.state === states.get(id)) return;
  if (view && activeId) states.set(activeId, view.state);
  const next = states.get(id) ?? createState("");
  states.set(id, next);
  activeId = id;
  if (view) view.setState(next);
}

export function focusEditor(): void {
  view?.focus();
}

export function configureSql(id: TabId, namespace: SQLNamespace | undefined, tables: readonly Completion[]): void {
  updateEditor(id, () => ({ effects: sqlConfig.reconfigure(sqlLanguage(namespace, tables)) }));
}

export function flashRanges(id: TabId, ranges: DocRange[]): void {
  updateEditor(id, () => ({ effects: flashEffect.of(ranges) }));
  setTimeout(() => updateEditor(id, () => ({ effects: clearFlash.of(null) })), 700);
}

export function showDiagnostics(id: TabId, diagnostics: Diagnostic[]): void {
  updateEditor(id, (state) => setDiagnostics(state, diagnostics));
}

export function insertAtCursor(id: TabId, text: string): void {
  updateEditor(id, (state) => {
    const { from, to } = state.selection.main;
    return { changes: { from, to, insert: text }, selection: { anchor: from + text.length } };
  });
}

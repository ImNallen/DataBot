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
import { Compartment, countColumn, EditorState, StateEffect, StateField, type Extension, type TransactionSpec } from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  layer,
  lineNumbers,
  type DecorationSet,
  type LayerMarker,
} from "@codemirror/view";
import type { DocRange, TabId } from "../../ipc/bindings";
import { editorHighlighting, editorTheme, functionCallStyle, LINE_PADDING_LEFT } from "./theme";

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

const previewEffect = StateEffect.define<DocRange[] | null>();
const previewMark = Decoration.mark({ class: "cm-preview" });

const previewField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(previewEffect)) next = Decoration.set((e.value ?? []).map((r) => previewMark.range(r.from, r.to)), true);
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const runTargetEffect = StateEffect.define<DocRange | null>();

// With a selection, ⌘↵ runs the selection, so the mark goes the moment one exists and never paints over it.
const runTargetField = StateField.define<DocRange | null>({
  create: () => null,
  update(range, tr) {
    if (!tr.state.selection.main.empty) return null;
    let next = range;
    if (range && tr.docChanged) {
      const mapped = { from: tr.changes.mapPos(range.from, 1), to: tr.changes.mapPos(range.to, -1) };
      next = mapped.from < mapped.to ? mapped : null;
    }
    for (const e of tr.effects) {
      if (e.is(runTargetEffect)) next = e.value && e.value.from < e.value.to && e.value.to <= tr.state.doc.length ? e.value : null;
    }
    return next;
  },
});

class RunTargetBox implements LayerMarker {
  constructor(
    readonly left: number,
    readonly top: number,
    readonly width: number,
    readonly height: number,
  ) {}
  draw(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-run-target";
    this.update(el);
    return el;
  }
  update(el: HTMLElement): boolean {
    el.style.left = `${this.left}px`;
    el.style.top = `${this.top}px`;
    el.style.width = `${this.width}px`;
    el.style.height = `${this.height}px`;
    return true;
  }
  eq(o: RunTargetBox): boolean {
    return o.left === this.left && o.top === this.top && o.width === this.width && o.height === this.height;
  }
}

/**
 * One rounded box behind the statement, as wide as its longest line. Width comes from columns, not drawn lines, so it holds
 * still while lines scroll in and out of the viewport, and it stops at the scroller's right edge so a very long line cannot
 * turn the whole editor into tint.
 */
function runTargetBox(v: EditorView): readonly LayerMarker[] {
  const range = v.state.field(runTargetField);
  if (!range) return [];
  const { doc, tabSize } = v.state;
  const first = doc.lineAt(range.from);
  const last = doc.lineAt(range.to);
  const startCol = first.number === last.number ? countColumn(first.text, tabSize, range.from - first.from) : 0;
  let endCol = 0;
  for (let n = first.number; n <= last.number; n++) {
    const line = doc.line(n);
    endCol = Math.max(endCol, countColumn(line.text, tabSize, Math.min(line.to, range.to) - line.from));
  }
  const scroller = v.scrollDOM.getBoundingClientRect();
  const textLeft = v.contentDOM.getBoundingClientRect().left - scroller.left + v.scrollDOM.scrollLeft + LINE_PADDING_LEFT;
  const docTop = v.documentTop - scroller.top + v.scrollDOM.scrollTop;
  const left = textLeft + startCol * v.defaultCharacterWidth - 6;
  const right = Math.min(textLeft + endCol * v.defaultCharacterWidth + 8, v.scrollDOM.clientWidth - 8);
  const top = docTop + v.lineBlockAt(range.from).top;
  const bottom = docTop + v.lineBlockAt(range.to).bottom;
  return [new RunTargetBox(left, top, Math.max(right - left, 0), bottom - top)];
}

const runTargetLayer = layer({
  above: false,
  class: "cm-runTargetLayer",
  markers: runTargetBox,
  update: (u) => u.geometryChanged || u.startState.field(runTargetField) !== u.state.field(runTargetField),
});

// The selection layer paints behind the text, so the active line's background would hide it.
const selectingClass = EditorView.editorAttributes.of((v) => (v.state.selection.main.empty ? null : { class: "cm-selecting" }));

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
      previewField,
      runTargetField,
      runTargetLayer,
      selectingClass,
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

export function editorStateOf(id: TabId): EditorState {
  if (id === activeId && view) return view.state;
  let state = states.get(id);
  if (!state) {
    state = createState("");
    states.set(id, state);
  }
  return state;
}

export function cursorOf(state: EditorState): { line: number; col: number } {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return { line: line.number, col: head - line.from + 1 };
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

/** Marks the statements a chooser row would run and scrolls the first into view; `null` clears the mark. */
export function previewRanges(id: TabId, ranges: DocRange[] | null): void {
  const first = ranges?.[0];
  updateEditor(id, () => ({ effects: first ? [previewEffect.of(ranges), EditorView.scrollIntoView(first.from, { y: "nearest" })] : previewEffect.of(null) }));
}

/** Draws a box behind the statement ⌘↵ would run. */
export function showRunTarget(id: TabId, range: DocRange | null): void {
  updateEditor(id, () => ({ effects: runTargetEffect.of(range) }));
}

/** The viewport's cursor line (the editor's top when the cursor is off screen) and the editor's visible right edge. */
export function cursorAnchor(): { right: number; top: number; bottom: number } | null {
  if (!view) return null;
  const box = view.scrollDOM.getBoundingClientRect();
  const at = view.coordsAtPos(view.state.selection.main.head);
  return { right: box.right, top: at?.top ?? box.top, bottom: at?.bottom ?? box.top };
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

/** Swaps the whole document in one transaction. Its userEvent keeps history from joining it with recent typing, so one undo restores the old text. */
export function replaceDoc(id: TabId, text: string): void {
  updateEditor(id, (state) => ({ changes: { from: 0, to: state.doc.length, insert: text }, selection: { anchor: text.length }, userEvent: "input" }));
}

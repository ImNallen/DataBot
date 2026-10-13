import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

const MONO = '"JetBrains Mono Variable", ui-monospace, "SF Mono", Menlo, monospace';

export const editorTheme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "#0a0a0a", color: "#e5e5e5", fontSize: "13px" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: MONO, lineHeight: "20px", overflow: "auto" },
    ".cm-content": { padding: "12px 0 24px", caretColor: "#f5f5f5" },
    ".cm-line": { padding: "0 16px 0 18px" },
    ".cm-gutters": { backgroundColor: "#0a0a0a", color: "#5c5c5c", border: "none" },
    ".cm-lineNumbers .cm-gutterElement": { minWidth: "30px", padding: "0 0 0 8px", textAlign: "right" },
    ".cm-activeLine": { backgroundColor: "#141414" },
    ".cm-activeLineGutter": { backgroundColor: "#141414", color: "#a3a3a3" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#f5f5f5", borderLeftWidth: "1.5px" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "#1f3554 !important",
    },
    ".cm-matchingBracket": { backgroundColor: "#262626", outline: "none" },
    ".cm-call, .cm-call *": { color: "#e5e5e5 !important" },
    ".cm-executed": { backgroundColor: "rgba(80, 162, 255, 0.13)", transition: "background-color 600ms ease-out" },
    ".cm-lintRange-error": {
      backgroundImage: "none",
      textDecoration: "underline wavy #ff6467",
      textDecorationSkipInk: "none",
      textUnderlineOffset: "3px",
    },
    ".cm-tooltip": { backgroundColor: "#111111", border: "1px solid #1d1d1d", borderRadius: "8px", color: "#e5e5e5", overflow: "hidden" },
    ".cm-tooltip-lint": { padding: "0" },
    ".cm-diagnostic": { padding: "6px 10px", fontFamily: "Inter Variable, sans-serif", fontSize: "12px" },
    ".cm-diagnostic-error": { borderLeft: "2px solid #ff6467" },
    ".cm-tooltip-autocomplete > ul": { fontFamily: MONO, fontSize: "12.5px", maxHeight: "280px" },
    ".cm-tooltip-autocomplete > ul > li": { padding: "3px 10px 3px 6px", lineHeight: "18px" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "#1a1b1b", color: "#f5f5f5" },
    ".cm-completionDetail": { color: "#818181", fontStyle: "normal", marginLeft: "12px" },
    ".cm-completionIcon": { opacity: "0.6", width: "18px" },
    ".cm-completionMatchedText": { textDecoration: "none", color: "#50a2ff" },
    ".cm-panels": { backgroundColor: "#111111", color: "#e5e5e5" },
    ".cm-searchMatch": { backgroundColor: "rgba(255, 185, 0, 0.18)" },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.bool, t.null, t.typeName], color: "#50a2ff" },
  { tag: [t.string, t.special(t.string)], color: "#00d492" },
  { tag: [t.number], color: "#ffb900" },
  { tag: [t.lineComment, t.blockComment, t.comment], color: "#818181" },
  { tag: [t.name, t.standard(t.name), t.propertyName, t.variableName], color: "#e5e5e5" },
  { tag: t.special(t.name), color: "#e5e5e5" },
  { tag: [t.operator, t.punctuation, t.paren, t.bracket], color: "#d4d4d4" },
]);

export const editorHighlighting = syntaxHighlighting(highlight);

const NOT_CALLS = new Set(["in", "values", "exists", "any", "all", "some", "over", "filter", "within", "using", "not", "and", "or", "on", "as", "from", "into", "table", "returning", "select"]);
const callMark = Decoration.mark({ class: "cm-call" });

function callDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        if (node.name !== "Keyword" || view.state.sliceDoc(node.to, node.to + 1) !== "(") return;
        if (!NOT_CALLS.has(view.state.sliceDoc(node.from, node.to).toLowerCase())) builder.add(node.from, node.to, callMark);
      },
    });
  }
  return builder.finish();
}

/**
 * PostgreSQL's keyword list includes aggregates such as count and sum; the mockup renders a
 * call like `count(` as a plain identifier, so keyword-named calls drop the keyword colour.
 */
export const functionCallStyle = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = callDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = callDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

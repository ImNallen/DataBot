import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

const MONO = '"JetBrains Mono Variable", ui-monospace, "SF Mono", Menlo, monospace';

const panelControl = {
  height: "24px",
  margin: "0 6px 0 0",
  padding: "0 8px",
  borderRadius: "6px",
  border: "1px solid var(--color-control)",
  fontSize: "12px",
  verticalAlign: "middle",
};

export const editorTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--color-bg)", color: "var(--code)", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: MONO, lineHeight: "20px", overflow: "auto" },
  ".cm-content": { padding: "12px 0 24px", caretColor: "var(--color-fg)" },
  ".cm-line": { padding: "0 16px 0 18px" },
  ".cm-gutters": { backgroundColor: "var(--color-bg)", color: "var(--color-faint)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "30px", padding: "0 0 0 8px", textAlign: "right" },
  ".cm-activeLine": { backgroundColor: "var(--color-hover)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--color-hover)", color: "var(--color-muted)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-fg)", borderLeftWidth: "1.5px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--code-selection) !important",
  },
  ".cm-matchingBracket": { backgroundColor: "var(--code-bracket)", outline: "none" },
  ".cm-selectionMatch": { backgroundColor: "var(--code-selection-match)" },
  ".cm-call, .cm-call *": { color: "var(--code) !important" },
  ".cm-executed": { backgroundColor: "var(--code-executed)", transition: "background-color 600ms ease-out" },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--color-danger)",
    textDecorationSkipInk: "none",
    textUnderlineOffset: "3px",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--color-raised)",
    border: "1px solid var(--color-control)",
    borderRadius: "8px",
    color: "var(--code)",
    overflow: "hidden",
  },
  ".cm-tooltip-lint": { padding: "0" },
  ".cm-diagnostic": { padding: "6px 10px", fontFamily: "Inter Variable, sans-serif", fontSize: "12px" },
  ".cm-diagnostic-error": { borderLeft: "2px solid var(--color-danger)" },
  ".cm-tooltip-autocomplete > ul": { fontFamily: MONO, fontSize: "12.5px", maxHeight: "280px" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "3px 10px 3px 6px", lineHeight: "18px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--color-selected)", color: "var(--color-fg)" },
  ".cm-completionDetail": { color: "var(--color-dim)", fontStyle: "normal", marginLeft: "12px" },
  ".cm-completionIcon": { opacity: "0.6", width: "18px" },
  ".cm-completionMatchedText": { textDecoration: "none", color: "var(--color-keyword)" },
  ".cm-panels": { backgroundColor: "var(--color-raised)", color: "var(--code)" },
  ".cm-panels-top": { borderBottom: "1px solid var(--color-border)" },
  ".cm-panels-bottom": { borderTop: "1px solid var(--color-border)" },
  ".cm-panel.cm-search": { display: "flex", flexWrap: "wrap", alignItems: "center", rowGap: "6px", padding: "8px 32px 8px 12px", fontFamily: "Inter Variable, sans-serif" },
  ".cm-panel.cm-search label": { display: "inline-flex", alignItems: "center", gap: "4px", margin: "0 10px 0 0", fontSize: "12px", color: "var(--color-muted)" },
  ".cm-panel.cm-search input[type=checkbox]": { margin: "0", accentColor: "var(--color-run)" },
  ".cm-panel.cm-search [name=close]": {
    top: "6px",
    right: "8px",
    width: "20px",
    height: "20px",
    borderRadius: "6px",
    color: "var(--color-muted)",
    fontSize: "16px",
    lineHeight: "18px",
  },
  ".cm-panel.cm-search [name=close]:hover": { backgroundColor: "var(--color-hover)", color: "var(--color-fg)" },
  ".cm-textfield": { ...panelControl, width: "200px", backgroundColor: "var(--color-bg)", color: "var(--color-fg)", outline: "none" },
  ".cm-textfield:focus": { borderColor: "var(--color-accent-border)" },
  ".cm-textfield::placeholder": { color: "var(--color-faint)" },
  ".cm-button": { ...panelControl, backgroundColor: "transparent", backgroundImage: "none", color: "var(--color-fg)", textTransform: "capitalize" },
  ".cm-button:hover": { backgroundColor: "var(--color-hover)" },
  ".cm-button:active": { backgroundImage: "none", backgroundColor: "var(--color-selected)" },
  ".cm-searchMatch": { backgroundColor: "var(--code-search-match)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--code-search-current)" },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.bool, t.null, t.typeName], color: "var(--color-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--color-green)" },
  { tag: [t.number], color: "var(--color-amber)" },
  { tag: [t.lineComment, t.blockComment, t.comment], color: "var(--color-dim)" },
  { tag: [t.name, t.standard(t.name), t.propertyName, t.variableName], color: "var(--code)" },
  { tag: t.special(t.name), color: "var(--code)" },
  { tag: [t.operator, t.punctuation, t.paren, t.bracket], color: "var(--code-punct)" },
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

import { PostgreSQL } from "@codemirror/lang-sql";
import { highlightTree } from "@lezer/highlight";
import { useMemo } from "react";
import { cx } from "../../ui/primitives";
import { isKeywordCall, staticSqlHighlighter } from "../editor/theme";

type Span = { text: string; className: string };

export function sqlSpans(sql: string): Span[] {
  const tree = PostgreSQL.language.parser.parse(sql);
  const calls = new Set<number>();
  tree.iterate({
    enter(node) {
      if (node.name === "Keyword" && isKeywordCall(sql.slice(node.from, node.to), sql.slice(node.to, node.to + 1))) calls.add(node.from);
    },
  });
  const spans: Span[] = [];
  let at = 0;
  highlightTree(tree, staticSqlHighlighter, (from, to, classes) => {
    if (from > at) spans.push({ text: sql.slice(at, from), className: "" });
    spans.push({ text: sql.slice(from, to), className: calls.has(from) ? "" : classes });
    at = to;
  });
  if (at < sql.length) spans.push({ text: sql.slice(at), className: "" });
  return spans;
}

export function SqlHighlight({ sql, className }: { sql: string; className?: string }) {
  const spans = useMemo(() => sqlSpans(sql), [sql]);
  return (
    <pre className={cx("selectable font-mono text-code-sm leading-[1.6] break-words whitespace-pre-wrap text-(color:--code)", className)}>
      {spans.map((s, i) => (s.className ? <span key={i} className={s.className}>{s.text}</span> : s.text))}
    </pre>
  );
}

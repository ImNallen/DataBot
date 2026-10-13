import type { DocRange, RunTarget } from "../ipc/bindings";

/**
 * A small splitter for the fake engine: enough lexing (quotes, comments, dollar quotes)
 * that the fake picks the same statements the real engine would for ordinary scripts.
 */
export function splitSql(text: string, base = 0): DocRange[] {
  const out: DocRange[] = [];
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    const range = trimRange(text, start, end);
    if (range) out.push({ from: range.from + base, to: range.to + base });
  };
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === "-" && next === "-") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl + 1;
    } else if (ch === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 2;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length && !(text[j] === ch && text[j + 1] !== ch)) j += text[j] === ch ? 2 : 1;
      i = j + 1;
    } else if (ch === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i))?.[0];
      if (tag) {
        const close = text.indexOf(tag, i + tag.length);
        i = close === -1 ? text.length : close + tag.length;
      } else i++;
    } else if (ch === ";") {
      push(i + 1);
      start = i + 1;
      i++;
    } else i++;
  }
  push(text.length);
  return out;
}

/** Trims whitespace around a span and drops spans that hold only comments. */
function trimRange(text: string, from: number, to: number): { from: number; to: number } | null {
  while (from < to && /\s/.test(text[from]!)) from++;
  while (to > from && /\s/.test(text[to - 1]!)) to--;
  if (from >= to) return null;
  const body = stripComments(text.slice(from, to)).replace(/;/g, "").trim();
  return body ? { from, to } : null;
}

export function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

export function pickStatements(text: string, target: RunTarget): DocRange[] {
  switch (target.kind) {
    case "all":
      return splitSql(text);
    case "selection":
      return splitSql(text.slice(target.from, target.to), target.from);
    case "cursor": {
      const all = splitSql(text);
      const at = all.find((r) => r.from <= target.offset && target.offset <= r.to);
      if (at) return [at];
      const before = all.filter((r) => r.to <= target.offset).at(-1);
      const after = all.find((r) => r.from >= target.offset);
      const picked = before ?? after;
      return picked ? [picked] : [];
    }
    default: {
      const unreachable: never = target;
      return unreachable;
    }
  }
}

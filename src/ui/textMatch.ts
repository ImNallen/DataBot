/** A half-open span of UTF-16 code units in a matched text. */
export type TextRange = { start: number; end: number };

/** The query's lowercase words. No words means no filter. */
export function parseQuery(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Null unless every token is a substring of `text`, ignoring case. Otherwise each token's first
 * occurrence, merged and sorted. Plain substrings keep a filter predictable: a fuzzy subsequence
 * lets "font" match "comfortable … layout".
 */
export function matchRanges(tokens: readonly string[], text: string): TextRange[] | null {
  const hay = text.toLowerCase();
  const found: TextRange[] = [];
  for (const token of tokens) {
    const start = hay.indexOf(token);
    if (start === -1) return null;
    found.push({ start, end: start + token.length });
  }
  found.sort((a, b) => a.start - b.start);
  const merged: TextRange[] = [];
  for (const r of found) {
    const last = merged.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

const WORD_BREAK = /[\s._\-/(]/;

/** Whether every token begins a word of `text`: at its start or after a space, `.`, `_`, `-`, `/`, or `(`. */
export function startsWords(tokens: readonly string[], text: string): boolean {
  const hay = text.toLowerCase();
  return tokens.every((token) => {
    for (let i = hay.indexOf(token); i !== -1; i = hay.indexOf(token, i + 1)) {
      if (i === 0 || WORD_BREAK.test(hay[i - 1]!)) return true;
    }
    return false;
  });
}

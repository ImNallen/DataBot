const BOUNDARY = /[\s._\-/(]/;

function isWordStart(text: string, i: number): boolean {
  return i === 0 || BOUNDARY.test(text[i - 1]!);
}

function matchToken(text: string, token: string, from: number): { score: number; end: number } | null {
  let substring = -1;
  for (let i = text.indexOf(token, from); i !== -1; i = text.indexOf(token, i + 1)) {
    if (isWordStart(text, i)) return { score: 10 * token.length + 5, end: i + token.length };
    if (substring === -1) substring = i;
  }
  if (substring !== -1) return { score: 6 * token.length, end: substring + token.length };

  let score = 0;
  let at = from;
  for (const ch of token) {
    let found = -1;
    for (let i = text.indexOf(ch, at); i !== -1; i = text.indexOf(ch, i + 1)) {
      if (found === -1) found = i;
      if (isWordStart(text, i)) {
        found = i;
        break;
      }
    }
    if (found === -1) return null;
    score += isWordStart(text, found) ? 5 : 2;
    score -= Math.min(found - at, 5) * 0.5;
    at = found + 1;
  }
  return { score, end: at };
}

function fuzzyScore(query: string, text: string): number | null {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const hay = text.toLowerCase();
  let total = 0;
  let at = 0;
  for (const token of tokens) {
    const m = matchToken(hay, token, at);
    if (!m) return null;
    total += m.score;
    at = m.end;
  }
  const compact = tokens.join("");
  if (hay === compact) total += 50;
  else if (hay.startsWith(tokens[0]!)) total += 10;
  return total - hay.length * 0.1;
}

export function fuzzyRank<T>(query: string, items: readonly T[], text: (item: T) => string, limit = 50): T[] {
  const scored: { item: T; score: number; order: number }[] = [];
  items.forEach((item, order) => {
    const score = fuzzyScore(query, text(item));
    if (score !== null) scored.push({ item, score, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, limit).map((s) => s.item);
}

import type { TypeCategory } from "../../ipc/bindings";

const PLAIN_NUMBER = /^([+-]?)(\d+)(\.\d*)?([eE][+-]?\d+)?$/;

/**
 * Inserts thousands separators into PostgreSQL's text output of a number.
 * Works on the string so numeric(38,10) and int8 values keep every digit.
 * Anything that is not a plain decimal (NaN, Infinity, money's "$1,234.00") passes through.
 */
export function groupDigits(text: string): string {
  const m = PLAIN_NUMBER.exec(text);
  if (!m) return text;
  const [, sign = "", int = "", frac = "", exp = ""] = m;
  return sign + int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + frac + exp;
}

export function isRightAligned(category: TypeCategory): boolean {
  return category === "Numeric";
}

const UNITS: readonly [number, string][] = [
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "k"],
];

/** Row estimates as the tree shows them: 18400 -> "18.4k", 241000 -> "241k", 999999 -> "1M". */
export function compactCount(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  let i = UNITS.findIndex(([base]) => abs >= base);
  let text = scaleTo(n, UNITS[i]![0]);
  // Rounding can carry into the next unit (999_999 -> "1000k"); promote instead.
  if (Math.abs(Number(text)) >= 1000 && i > 0) {
    i -= 1;
    text = scaleTo(n, UNITS[i]![0]);
  }
  return text + UNITS[i]![1];
}

function scaleTo(n: number, base: number): string {
  const scaled = n / base;
  return String(Math.abs(scaled) >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10);
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function pluralRows(n: number): string {
  return `${groupDigits(String(n))} ${n === 1 ? "row" : "rows"}`;
}

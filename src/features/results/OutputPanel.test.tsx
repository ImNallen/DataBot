import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { OutputBody, OutputEntry } from "../../ipc/bindings";
import { OUTPUT_LIMIT } from "../../state/live";
import { OutputPanel } from "./OutputPanel";

const at = new Date(2026, 9, 15, 9, 5, 7).getTime();
const entry = (runId: number, body: OutputBody): OutputEntry => ({ atMs: at, runId, body });

const lines = (entries: OutputEntry[]) =>
  renderToStaticMarkup(<OutputPanel entries={entries} />)
    .split('<div data-testid="output-line"')
    .slice(1)
    .map((html) => {
      const attrs = html.slice(0, html.indexOf(">"));
      return {
        kind: attrs.match(/data-kind="(\w+)"/)?.[1],
        severity: attrs.match(/data-severity="(\w+)"/)?.[1],
        runStart: attrs.includes("border-t"),
        text: html
          .slice(attrs.length + 1)
          .replace(/<[^>]+>/g, "")
          .replace(/&gt;/g, ">"),
      };
    });

it("prints each entry as a timestamped line in DataGrip's Output order", () => {
  const error = { severity: "ERROR", sqlstate: "22012", message: "division by zero", detail: null, hint: null, context: null, position: null };
  expect(
    lines([
      entry(1, { kind: "Statement", statement: 0, text: "select slow_echo(0.01)" }),
      entry(1, { kind: "Notice", severity: "WARNING", message: "careful", detail: "more" }),
      entry(1, { kind: "Rows", statement: 0, rows: 200_000, elapsedMs: 1_200, truncated: true }),
      entry(1, { kind: "Info", message: "BEGIN (implicit)" }),
      entry(1, { kind: "Command", statement: 1, tag: "UPDATE 3", elapsedMs: 4 }),
      entry(2, { kind: "Statement", statement: 0, text: "select 1/0" }),
      entry(2, { kind: "Error", statement: 0, error }),
    ]),
  ).toEqual([
    { kind: "Statement", severity: undefined, runStart: false, text: "09:05:07>select slow_echo(0.01)" },
    { kind: "Notice", severity: "WARNING", runStart: false, text: "09:05:07WARNING:carefulmore" },
    { kind: "Rows", severity: undefined, runStart: false, text: "09:05:07200,000 rows (truncated) · 1.20 s" },
    { kind: "Info", severity: undefined, runStart: false, text: "09:05:07BEGIN (implicit)" },
    { kind: "Command", severity: undefined, runStart: false, text: "09:05:07UPDATE 3 · 4 ms" },
    { kind: "Statement", severity: undefined, runStart: true, text: "09:05:07>select 1/0" },
    { kind: "Error", severity: "ERROR", runStart: false, text: "09:05:07ERROR:division by zeroSQLSTATE 22012" },
  ]);
});

it("says lines were dropped only when the log is at its cap", () => {
  const info = entry(1, { kind: "Info", message: "x" });
  expect(renderToStaticMarkup(<OutputPanel entries={[info]} />)).not.toContain("Only the last");
  expect(renderToStaticMarkup(<OutputPanel entries={Array.from({ length: OUTPUT_LIMIT }, () => info)} />)).toContain("Only the last 5,000 lines are kept.");
});

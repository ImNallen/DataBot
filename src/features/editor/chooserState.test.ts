import { expect, it } from "vitest";
import { choiceRanges, choiceTarget, moveChoice, startLines, statementLabel } from "./chooserState";

const text = "select 1 as one;\nselect * from public.orders limit 3;\nselect 'third' as three;";
const statements = [
  { from: 0, to: 15 },
  { from: 17, to: 52 },
  { from: 54, to: 77 },
];

it("labels a statement by its first non-empty line, whitespace collapsed and cut near 60 chars", () => {
  expect(statementLabel(text, statements[1]!)).toBe("select * from public.orders limit 3");
  expect(statementLabel("\n   \n  select   a,\n  b from t", { from: 0, to: 28 })).toBe("select a,");
  const long = `select ${"column_name, ".repeat(10)}x from t`;
  expect(statementLabel(long, { from: 0, to: long.length })).toBe("select column_name, column_name, column_name, column_name,…");
});

it("numbers the line each statement starts on", () => {
  expect(startLines(text, statements)).toEqual([1, 2, 3]);
  expect(startLines("\n\nselect 1;\n\n\nselect 2", [{ from: 2, to: 10 }, { from: 14, to: 22 }])).toEqual([3, 6]);
});

it("moves through the statements and then All, wrapping at both ends", () => {
  const second = { kind: "statement", index: 1 } as const;
  expect(moveChoice(second, 3, "ArrowDown")).toEqual({ kind: "statement", index: 2 });
  expect(moveChoice({ kind: "statement", index: 2 }, 3, "ArrowDown")).toEqual({ kind: "all" });
  expect(moveChoice({ kind: "all" }, 3, "ArrowDown")).toEqual({ kind: "statement", index: 0 });
  expect(moveChoice({ kind: "statement", index: 0 }, 3, "ArrowUp")).toEqual({ kind: "all" });
  expect(moveChoice(second, 3, "Home")).toEqual({ kind: "statement", index: 0 });
  expect(moveChoice(second, 3, "End")).toEqual({ kind: "all" });
  expect(moveChoice(second, 3, "x")).toBeNull();
});

it("runs a chosen statement as its range and All as the whole script", () => {
  expect(choiceTarget(statements, { kind: "statement", index: 2 })).toEqual({ kind: "selection", from: 54, to: 77 });
  expect(choiceTarget(statements, { kind: "all" })).toEqual({ kind: "all" });
  expect(choiceRanges(statements, { kind: "statement", index: 0 })).toEqual([{ from: 0, to: 15 }]);
  expect(choiceRanges(statements, { kind: "all" })).toEqual(statements);
});

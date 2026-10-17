import { create } from "zustand";
import type { DocRange, RunTarget, TabId } from "../../ipc/bindings";
import { focusEditor, previewRanges } from "./editorStates";

export type Choice = { kind: "statement"; index: number } | { kind: "all" };
/** The cursor line's top and bottom, and the editor's right edge, in viewport pixels. */
export type Anchor = { right: number; top: number; bottom: number };
export type OpenChooser = { kind: "open"; tabId: TabId; text: string; statements: DocRange[]; active: Choice; anchor: Anchor };
export type Chooser = { kind: "closed" } | OpenChooser;

export const useChooser = create<{ chooser: Chooser }>(() => ({ chooser: { kind: "closed" } }));

export function choiceRanges(statements: DocRange[], choice: Choice): DocRange[] {
  if (choice.kind === "all") return statements;
  const range = statements[choice.index];
  return range ? [range] : [];
}

export function choiceTarget(statements: DocRange[], choice: Choice): RunTarget {
  const range = statements[choice.kind === "statement" ? choice.index : -1];
  return range ? { kind: "selection", from: range.from, to: range.to } : { kind: "all" };
}

/** One statement or more get the "All" row only from two up. */
export const hasAllRow = (count: number) => count > 1;

/** The chooser's rows are the statements, then "All" when there are several; arrows wrap. */
export function moveChoice(active: Choice, count: number, key: string): Choice | null {
  const rows = hasAllRow(count) ? count + 1 : count;
  const at = active.kind === "all" ? count : active.index;
  const to = { ArrowDown: (at + 1) % rows, ArrowUp: (at + rows - 1) % rows, Home: 0, End: rows - 1 }[key];
  if (to === undefined) return null;
  return to === count ? { kind: "all" } : { kind: "statement", index: to };
}

const LABEL_MAX = 60;

export function statementLabel(text: string, range: DocRange): string {
  const line = text
    .slice(range.from, range.to)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find((l) => l !== "") ?? "";
  return line.length > LABEL_MAX ? `${line.slice(0, LABEL_MAX - 1).trimEnd()}…` : line;
}

/** The 1-based line each range starts on, in one pass over the text. Ranges are in document order. */
export function startLines(text: string, ranges: DocRange[]): number[] {
  let line = 1;
  let at = 0;
  return ranges.map((r) => {
    for (; at < r.from; at++) if (text.charCodeAt(at) === 10) line++;
    return line;
  });
}

export function openChooser(open: Omit<OpenChooser, "kind">): void {
  closeChooser();
  useChooser.setState({ chooser: { kind: "open", ...open } });
  previewRanges(open.tabId, choiceRanges(open.statements, open.active));
}

export function highlightChoice(choice: Choice): void {
  const { chooser } = useChooser.getState();
  if (chooser.kind !== "open") return;
  useChooser.setState({ chooser: { ...chooser, active: choice } });
  previewRanges(chooser.tabId, choiceRanges(chooser.statements, choice));
}

export function closeChooser(): void {
  const { chooser } = useChooser.getState();
  if (chooser.kind !== "open") return;
  useChooser.setState({ chooser: { kind: "closed" } });
  previewRanges(chooser.tabId, null);
  focusEditor();
}

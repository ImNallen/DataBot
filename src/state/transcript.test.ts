import { expect, it } from "vitest";
import type { ChatState, Entry, EntrySnapshot, ToolStatus, ToolUse } from "../ipc/bindings";
import { groupTurns, needsResync, toolLine } from "./transcript";

const CHAT = "6f1c2d3e-0000-4000-8000-000000000001";
const snap = (seq: number, turn: number, entry: Entry): EntrySnapshot => ({ chatId: CHAT, seq, rev: 100 + seq, turn, entry });
const held = (...snaps: EntrySnapshot[]) => Object.fromEntries(snaps.map((s) => [s.seq, s]));

const ask = (text: string): Entry => ({ kind: "User", atMs: 1, text, context: null, attachment: null });
const say = (text: string): Entry => ({ kind: "Text", blocks: [{ kind: "Markdown", text }], done: true });
const done: Entry = { kind: "End", atMs: 2, outcome: { kind: "Completed" }, suggestions: ["Only EU regions"] };

it("groups entries into turns by their turn stamp, in seq order, whatever order they are held in", () => {
  const describe = snap(1, 0, { kind: "Tool", call: "toolu_1", tool: { kind: "DescribeTables", tables: ["orders"] }, status: { kind: "Running" } });
  const reply = snap(2, 0, say("Revenue by region"));
  const second = snap(4, 4, ask("Only EU?"));
  const streaming = snap(5, 4, say("Filtering"));
  const turns = groupTurns(held(streaming, snap(3, 0, done), reply, second, describe, snap(0, 0, ask("Which regions grew?"))));
  expect(turns.map((t) => ({ turn: t.turn, user: t.user && [t.user.seq, t.user.entry.text], items: t.items.map((i) => i.seq), end: t.end?.seq ?? null }))).toEqual([
    { turn: 0, user: [0, "Which regions grew?"], items: [1, 2], end: 3 },
    { turn: 4, user: [4, "Only EU?"], items: [5], end: null },
  ]);
  expect(turns[0]?.items[1]).toBe(reply);
  expect(turns[1]?.items[0]).toBe(streaming);
  expect(groupTurns(undefined)).toEqual([]);
});

it("keeps a turn whose user entry has not arrived yet, with no user", () => {
  expect(groupTurns(held(snap(7, 6, say("partial")))).map((t) => [t.turn, t.user, t.items.length])).toEqual([[6, null, 1]]);
});

const RUN: ToolUse = { kind: "RunQuery", sql: "select region from customers", purpose: "List regions", relations: ["customers"] };
const DESCRIBE: ToolUse = { kind: "DescribeTables", tables: ["orders", "customers"] };
const SEARCH: ToolUse = { kind: "SearchCatalog", query: "region" };
const OTHER: ToolUse = { kind: "Other", name: "Bash" };

it("says what each tool did in one line, for every status", () => {
  const cases: [ToolUse, ToolStatus][] = [
    [DESCRIBE, { kind: "Done", result: { kind: "Described", found: ["orders", "customers"], missing: [] } }],
    [DESCRIBE, { kind: "Done", result: { kind: "Described", found: ["orders"], missing: ["custmers"] } }],
    [SEARCH, { kind: "Done", result: { kind: "Found", matches: 7 } }],
    [SEARCH, { kind: "Done", result: { kind: "Found", matches: 1 } }],
    [RUN, { kind: "Done", result: { kind: "Rows", columns: ["region"], rows: [["EU-West"], ["US-West"], ["APAC"], ["US-East"], ["LATAM"], ["EU-North"]], more: false, elapsedMs: 27 } }],
    [RUN, { kind: "Done", result: { kind: "Rows", columns: ["n"], rows: [["1"]], more: false, elapsedMs: 1450 } }],
    [RUN, { kind: "Done", result: { kind: "Rows", columns: ["id"], rows: Array.from({ length: 50 }, (_, i) => [String(i)]), more: true, elapsedMs: 3 } }],
    [DESCRIBE, { kind: "Running" }],
    [SEARCH, { kind: "Running" }],
    [RUN, { kind: "Running" }],
    [OTHER, { kind: "Running" }],
    [RUN, { kind: "AwaitingApproval", approval: 3, reason: { kind: "AskFirst" } }],
    [RUN, { kind: "Failed", message: "Only read queries run here." }],
    [OTHER, { kind: "Failed", message: "L1 Data does not serve this tool." }],
    [RUN, { kind: "Denied", stopped: false }],
    [RUN, { kind: "Denied", stopped: true }],
    [RUN, { kind: "Expired" }],
  ];
  expect(cases.map(([tool, status]) => toolLine(tool, status))).toEqual([
    "Described orders, customers",
    "Described orders · not found: custmers",
    "Searched 'region' · 7 matches",
    "Searched 'region' · 1 match",
    "Ran query · 6 rows · 27 ms",
    "Ran query · 1 row · 1.45 s",
    "Ran query · 50+ rows · 3 ms",
    "Describing orders, customers",
    "Searching 'region'",
    "Running query",
    "Calling Bash",
    "Waiting for approval",
    "Query failed · Only read queries run here.",
    "Bash refused · L1 Data does not serve this tool.",
    "Denied",
    "Stopped",
    "Expired",
  ]);
});

const chat = (status: ChatState["status"], entryCount: number): ChatState => ({
  id: CHAT,
  rev: 9,
  title: "Which regions grew?",
  updatedAtMs: 1,
  options: { provider: "Claude", model: "opus", effort: "high", permission: "AskFirst" },
  status,
  entryCount,
});

it("asks for a reopen only when an opened, idle chat reports more entries than the panel holds", () => {
  const two = held(snap(0, 0, ask("hi")), snap(1, 0, say("hello")));
  expect([
    needsResync(chat({ kind: "Idle" }, 3), two),
    needsResync(chat({ kind: "Idle" }, 2), two),
    needsResync(chat({ kind: "Running", turn: 0, startedAtMs: 1, phase: "Working" }, 3), two),
    needsResync(chat({ kind: "Idle" }, 3), undefined),
  ]).toEqual([true, false, false, false]);
});

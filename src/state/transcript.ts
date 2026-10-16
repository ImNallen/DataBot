import type { ChatState, ChatStatus, Entry, EntrySnapshot, ToolStatus, ToolUse, TurnPhase } from "../ipc/bindings";
import { formatElapsed, pluralRows } from "../features/results/format";

export type UserEntry = Extract<Entry, { kind: "User" }>;
export type EndEntry = Extract<Entry, { kind: "End" }>;

export type TurnView = {
  turn: number;
  user: { seq: number; entry: UserEntry } | null;
  items: EntrySnapshot[];
  end: { seq: number; entry: EndEntry } | null;
};

export function groupTurns(entries: Record<number, EntrySnapshot> | undefined): TurnView[] {
  const turns = new Map<number, TurnView>();
  const ordered = Object.values(entries ?? {}).sort((a, b) => a.seq - b.seq);
  for (const snap of ordered) {
    let view = turns.get(snap.turn);
    if (!view) {
      view = { turn: snap.turn, user: null, items: [], end: null };
      turns.set(snap.turn, view);
    }
    const { entry } = snap;
    if (entry.kind === "User") view.user = { seq: snap.seq, entry };
    else if (entry.kind === "End") view.end = { seq: snap.seq, entry };
    else view.items.push(snap);
  }
  return [...turns.values()].sort((a, b) => a.turn - b.turn);
}

export function needsResync(chat: ChatState, held: Record<number, EntrySnapshot>): boolean {
  return chat.status.kind === "Idle" && chat.entryCount > Object.keys(held).length;
}

export function awaitsApproval(chat: ChatState): boolean {
  return chat.status.kind === "Running" && chat.status.phase === "AwaitingApproval";
}

const PHASE_NOTES = {
  Starting: "Running",
  Working: "Running",
  AwaitingApproval: "Waiting for approval",
} satisfies Record<TurnPhase, string>;

export function runningNote(status: ChatStatus): string | null {
  return status.kind === "Running" ? PHASE_NOTES[status.phase] : null;
}

const names = (xs: readonly string[]) => xs.join(", ");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "es"}`;

function running(tool: ToolUse): string {
  switch (tool.kind) {
    case "DescribeTables":
      return `Describing ${names(tool.tables)}`;
    case "SearchCatalog":
      return `Searching '${tool.query}'`;
    case "RunQuery":
      return "Running query";
    case "Other":
      return `Calling ${tool.name}`;
    default: {
      const unreachable: never = tool;
      return unreachable;
    }
  }
}

function failed(tool: ToolUse): string {
  switch (tool.kind) {
    case "DescribeTables":
      return "Describe failed";
    case "SearchCatalog":
      return "Search failed";
    case "RunQuery":
      return "Query failed";
    case "Other":
      return `${tool.name} refused`;
    default: {
      const unreachable: never = tool;
      return unreachable;
    }
  }
}

export function toolLine(tool: ToolUse, status: ToolStatus): string {
  switch (status.kind) {
    case "Running":
      return running(tool);
    case "AwaitingApproval":
      return "Waiting for approval";
    case "Done": {
      const r = status.result;
      switch (r.kind) {
        case "Described":
          return r.missing.length > 0 ? `Described ${names(r.found)} · not found: ${names(r.missing)}` : `Described ${names(r.found)}`;
        case "Found":
          return `Searched '${tool.kind === "SearchCatalog" ? tool.query : ""}' · ${plural(r.matches, "match")}`;
        case "Rows":
          return `Ran query · ${r.more ? `${r.rows.length}+ rows` : pluralRows(r.rows.length)} · ${formatElapsed(r.elapsedMs)}`;
        default: {
          const unreachable: never = r;
          return unreachable;
        }
      }
    }
    case "Failed":
      return `${failed(tool)} · ${status.message}`;
    case "Denied":
      return status.stopped ? "Stopped" : "Denied";
    case "Expired":
      return "Expired";
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

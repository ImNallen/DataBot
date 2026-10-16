import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { ChatId, ChatState, DatabaseRef, EntrySnapshot } from "../../ipc/bindings";
import { useLive } from "../../state/live";
import { groupTurns, type EndEntry, type TurnView, type UserEntry } from "../../state/transcript";
import { useWorkspace } from "../../state/workspace";
import { Button } from "../../ui/primitives";
import { agentErrorText, contextChip, type ProviderVoice } from "./assistantText";
import { sendMessage } from "./assistantActions";
import { ReplyText } from "./ReplyText";
import { ToolCard } from "./ToolCard";

const PIN_SLACK_PX = 32;

function UserMessage({ seq, entry }: { seq: number; entry: UserEntry }) {
  const chip = contextChip(entry);
  return (
    <div data-testid={`chat-user-${seq}`} className="flex flex-col items-end gap-1 pl-8">
      <p className="selectable rounded-xl bg-pill px-3 py-2 text-ui-13 leading-relaxed break-words whitespace-pre-wrap text-fg">{entry.text}</p>
      {chip && <p className="px-1 text-right text-ui-11.5 text-faint">{chip}</p>}
    </div>
  );
}

const Item = memo(function Item({ chatId, snap, db }: { chatId: ChatId; snap: EntrySnapshot; db: DatabaseRef | null }) {
  const { entry, seq } = snap;
  switch (entry.kind) {
    case "Text":
      return <ReplyText testId={`chat-text-${seq}`} blocks={entry.blocks} db={db} />;
    case "Tool":
      return <ToolCard chatId={chatId} seq={seq} tool={entry.tool} status={entry.status} db={db} />;
    case "Notice":
      return <p className="text-ui-12.5 text-dim italic">{entry.text}</p>;
    case "Unreadable":
      return <p className="text-ui-12.5 text-dim italic">A newer version of L1 Data wrote this part of the chat, so it can't be shown.</p>;
    case "User":
    case "End":
      return null;
    default: {
      const unreachable: never = entry;
      return unreachable;
    }
  }
});

function EndBody({ chatId, end, user, last, idle, voice }: { chatId: ChatId; end: EndEntry; user: UserEntry | null; last: boolean; idle: boolean; voice: ProviderVoice }) {
  const { outcome } = end;
  switch (outcome.kind) {
    case "Completed":
      if (!last) return null;
      return end.suggestions.map((s) => (
        <button
          key={s}
          type="button"
          data-testid="suggestion-chip"
          disabled={!idle}
          onClick={() => void sendMessage(chatId, s, false)}
          className="rounded-lg border border-control px-2.5 py-1 text-left text-ui-12.5 text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"
        >
          {s}
        </button>
      ));
    case "Stopped":
      return <p className="text-ui-12.5 text-dim">Stopped</p>;
    case "Lost":
      return <p className="text-ui-12.5 text-dim">Stopped when L1 Data quit.</p>;
    case "Failed": {
      const { text, action } = agentErrorText(outcome.error, voice);
      return (
        <>
          <p className="selectable min-w-0 text-ui-12.5 break-words text-danger">{text}</p>
          {action === "settings" ? (
            <Button variant="ghost" className="h-6 px-2 text-ui-12" onClick={() => useWorkspace.getState().openSettings("providers")}>
              Open settings
            </Button>
          ) : (
            user && (
              <Button variant="ghost" className="h-6 px-2 text-ui-12" disabled={!idle} onClick={() => void sendMessage(chatId, user.text, false)}>
                Retry
              </Button>
            )
          )}
        </>
      );
    }
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

function Turn({ chat, view, last, voice }: { chat: ChatState; view: TurnView; last: boolean; voice: ProviderVoice }) {
  const db = view.user?.entry.context?.db ?? null;
  const status = chat.status;
  const phase = status.kind === "Running" && status.turn === view.turn ? status.phase : null;
  const waiting = (phase === "Starting" || phase === "Working") && !view.items.some((i) => i.entry.kind === "Text");
  return (
    <div className="flex flex-col gap-3">
      {view.user && <UserMessage seq={view.user.seq} entry={view.user.entry} />}
      {view.items.map((snap) => (
        <Item key={snap.seq} chatId={chat.id} snap={snap} db={db} />
      ))}
      {waiting && <p className="animate-pulse text-ui-12.5 text-dim">{phase === "Starting" ? `Starting ${voice.name}…` : "Thinking…"}</p>}
      {view.end && (
        <div data-testid={`chat-end-${view.end.seq}`} data-outcome={view.end.entry.outcome.kind} className="flex flex-wrap items-center gap-x-2 gap-y-1.5 empty:hidden">
          <EndBody chatId={chat.id} end={view.end.entry} user={view.user?.entry ?? null} last={last} idle={status.kind === "Idle"} voice={voice} />
        </div>
      )}
    </div>
  );
}

export function Transcript({ chat }: { chat: ChatState }) {
  const entries = useLive((s) => s.transcripts[chat.id]);
  const turns = useMemo(() => groupTurns(entries), [entries]);
  const name = useWorkspace((s) => s.settings.providers.find((p) => p.provider === chat.options.provider)?.displayName);
  const signInCommand = useLive((s) => s.providers[chat.options.provider]?.info.signInCommand);
  const voice = { name: name ?? chat.options.provider, signInCommand: signInCommand ?? "" };

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const follow = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    follow.observe(inner);
    return () => follow.disconnect();
  }, []);
  const lastTurn = turns.at(-1)?.turn;
  useLayoutEffect(() => {
    pinned.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastTurn]);

  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK_PX;
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div ref={content} className="flex flex-col gap-6 px-4 pt-2 pb-6">
        {turns.length === 0 ? (
          <p className="pt-10 text-center text-ui-12.5 text-dim">Ask about your data. Each message carries the active tab's database and SQL.</p>
        ) : (
          turns.map((t, i) => <Turn key={t.turn} chat={chat} view={t} last={i === turns.length - 1} voice={voice} />)
        )}
      </div>
    </div>
  );
}

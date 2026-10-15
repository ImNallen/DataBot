import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { IconClock } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { commands, type HistoryOutcome } from "../../ipc/bindings";
import { useLive } from "../../state/live";
import { useWorkspace } from "../../state/workspace";
import { cx, DialogBackdrop } from "../../ui/primitives";
import { openSqlTab } from "../editor/runActions";
import { formatElapsed, pluralRows } from "../results/format";
import { appendOlder, firstPageQuery, olderPageQuery, withTail, type HistoryList } from "./historyList";

const LOAD_OLDER_WITHIN_PX = 200;

function outcomeText(o: HistoryOutcome): string {
  switch (o.kind) {
    case "Rows":
      return pluralRows(o.rows);
    case "Command":
      return o.tag;
    case "Error":
      return o.message;
    case "Cancelled":
      return "Cancelled";
    default: {
      const unreachable: never = o;
      return unreachable;
    }
  }
}

function ago(atMs: number, now: number): string {
  const s = Math.max(0, Math.round((now - atMs) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(atMs).toLocaleDateString();
}

function clearHistory() {
  useWorkspace.getState().open({
    kind: "confirm",
    title: "Clear query history?",
    body: "This removes every saved query from history.",
    confirmLabel: "Clear history",
    onConfirm: () => void commands.historyClear().then(() => useLive.setState({ historyTail: [] })),
  });
}

// Mounted only while the popover is open, so every open starts with an empty search and fresh results.
function HistoryBrowser({ close }: { close: () => void }) {
  const [query, setQuery] = useState("");
  const [list, setList] = useState<HistoryList | null>(null);
  // Scroll fires many times before an appended page renders, so each list asks for its next page once.
  const loadingOlderFor = useRef<HistoryList | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState("");
  const tail = useLive((s) => s.historyTail);

  useEffect(() => {
    let cancelled = false;
    const text = query.trim();
    const t = setTimeout(
      async () => {
        const page = await commands.historyList(firstPageQuery(text));
        if (cancelled) return;
        // Results land after cmdk reacted to the keystroke, so the new search's top row is selected and scrolled to here.
        const next = { text, ...page };
        setList(next);
        setSelected(String(withTail(next, useLive.getState().historyTail)[0]?.id ?? ""));
        listRef.current?.scrollTo({ top: 0 });
      },
      text ? 150 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const entries = useMemo(() => (list ? withTail(list, tail) : []), [list, tail]);

  const loadOlder = () => {
    const q = list && olderPageQuery(list);
    if (!q || loadingOlderFor.current === list) return;
    loadingOlderFor.current = list;
    const requested = list;
    void commands.historyList(q).then((page) => setList((cur) => cur && appendOlder(cur, requested, page)));
  };

  const now = Date.now();
  return (
    <Command shouldFilter={false} label="Query history" value={selected} onValueChange={setSelected}>
      <div className="flex h-12 items-center gap-2.5 border-b border-control px-4">
        <IconClock size={16} className="shrink-0 text-green" />
        <Command.Input
          data-testid="history-input"
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder="Search query history"
          className="h-full flex-1 bg-transparent text-ui-14 text-fg outline-none placeholder:text-faint"
        />
        {entries.length > 0 && (
          <button type="button" data-testid="history-clear" onClick={clearHistory} className="shrink-0 text-ui-12 text-dim hover:text-fg">
            Clear history
          </button>
        )}
      </div>
      <Command.List
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < LOAD_OLDER_WITHIN_PX) loadOlder();
        }}
        className="max-h-[360px] overflow-y-auto p-1.5"
      >
        {list && entries.length === 0 && (
          <div className="px-3 py-6 text-center text-ui-13 text-dim">{list.text ? "No matches" : "No queries yet"}</div>
        )}
        {entries.map((h) => (
          <Command.Item
            key={h.id}
            value={String(h.id)}
            data-testid="history-item"
            onSelect={() => {
              close();
              openSqlTab({ connectionId: h.connectionId, text: h.sql });
            }}
            className="cursor-default rounded-md px-2.5 py-2 data-[selected=true]:bg-selected"
          >
            <div className="line-clamp-2 font-mono text-ui-12 leading-[18px] break-all whitespace-pre-wrap text-fg">{h.sql}</div>
            <div className="mt-1 flex items-center gap-1.5 text-ui-11.5 text-dim">
              <span className="truncate">{h.connectionName}</span>
              <span>·</span>
              <span className={cx("truncate", h.outcome.kind === "Error" && "text-danger")}>{outcomeText(h.outcome)}</span>
              <span>·</span>
              <span className="shrink-0">{formatElapsed(h.elapsedMs)}</span>
              <span className="ml-auto shrink-0">{ago(h.atMs, now)}</span>
            </div>
          </Command.Item>
        ))}
      </Command.List>
    </Command>
  );
}

export function HistoryPalette() {
  const open = useWorkspace((s) => s.overlay.kind === "history");
  const close = useWorkspace((s) => s.close);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <DialogBackdrop />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="history-palette"
          className="motion-pop fixed top-[14%] left-1/2 z-50 w-[560px] -translate-x-1/2 overflow-hidden rounded-xl border border-control bg-raised shadow-[var(--shadow-dialog)] outline-none"
        >
          <Dialog.Title className="sr-only">Query history</Dialog.Title>
          <HistoryBrowser close={close} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

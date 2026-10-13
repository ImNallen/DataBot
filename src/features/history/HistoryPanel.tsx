import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { commands, type HistoryEntry, type HistoryOutcome } from "../../ipc/bindings";
import { useLive } from "../../state/live";
import { useWorkspace } from "../../state/workspace";
import { cx } from "../../ui/primitives";
import { openSqlTab } from "../editor/runActions";
import { formatElapsed, pluralRows } from "../results/format";

const PAGE = 100;

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

export function HistoryPanel() {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<{ entries: HistoryEntry[]; hasMore: boolean; text: string } | null>(null);
  const tail = useLive((s) => s.historyTail);
  const open = useWorkspace((s) => s.open);

  useEffect(() => {
    let cancelled = false;
    const text = query.trim();
    const t = setTimeout(async () => {
      const res = await commands.historyList({ text: text || null, connectionId: null, beforeId: null, limit: PAGE });
      if (!cancelled) setPage({ ...res, text });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const entries = useMemo(() => {
    if (!page) return [];
    const newest = page.entries[0]?.id ?? 0;
    const needle = page.text.toLowerCase();
    const fresh = tail.filter((h) => h.id > newest && (!needle || h.sql.toLowerCase().includes(needle)));
    return [...fresh, ...page.entries];
  }, [page, tail]);

  const loadMore = async () => {
    if (!page) return;
    const last = page.entries.at(-1);
    const res = await commands.historyList({ text: page.text || null, connectionId: null, beforeId: last?.id ?? null, limit: PAGE });
    setPage({ entries: [...page.entries, ...res.entries], hasMore: res.hasMore, text: page.text });
  };

  const now = Date.now();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
        <label className="flex h-8 flex-1 items-center gap-2 rounded-lg border border-control px-2.5">
          <Search size={14} className="shrink-0 text-dim" />
          <input
            data-testid="history-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search history"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
          />
        </label>
        <button
          type="button"
          className="text-[12px] text-dim hover:text-fg"
          onClick={() =>
            open({
              kind: "confirm",
              title: "Clear query history?",
              body: "This removes every saved query from history.",
              confirmLabel: "Clear history",
              onConfirm: () => void commands.historyClear().then(() => setPage({ entries: [], hasMore: false, text: "" })),
            })
          }
        >
          Clear
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {page && entries.length === 0 && (
          <div className="px-3 py-8 text-center text-[13px] text-dim">{page.text ? "No queries match." : "Queries you run appear here."}</div>
        )}
        {entries.map((h) => (
          <button
            key={h.id}
            type="button"
            data-testid="history-item"
            onClick={() => openSqlTab({ connectionId: h.connectionId, text: h.sql })}
            className="block w-full rounded-lg px-2.5 py-2 text-left hover:bg-hover"
          >
            <div className="line-clamp-3 font-mono text-[12px] leading-[18px] break-all whitespace-pre-wrap text-fg">{h.sql}</div>
            <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-dim">
              <span className="truncate">{h.connectionName}</span>
              <span>·</span>
              <span className={cx("truncate", h.outcome.kind === "Error" && "text-danger")}>{outcomeText(h.outcome)}</span>
              <span>·</span>
              <span className="shrink-0">{formatElapsed(h.elapsedMs)}</span>
              <span className="ml-auto shrink-0">{ago(h.atMs, now)}</span>
            </div>
          </button>
        ))}
        {page?.hasMore && (
          <button type="button" onClick={() => void loadMore()} className="mt-1 w-full py-2 text-[12.5px] text-dim hover:text-fg">
            Load older queries
          </button>
        )}
      </div>
    </div>
  );
}

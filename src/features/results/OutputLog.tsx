import { useEffect, useRef } from "react";
import type { OutputBody, OutputEntry, QueryError, TabId } from "../../ipc/bindings";
import { useLive } from "../../state/live";
import { cx } from "../../ui/primitives";
import { formatElapsed, pluralRows } from "./format";

const EMPTY: OutputEntry[] = [];

function clock(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function ErrorBody({ error }: { error: QueryError }) {
  return (
    <div className="min-w-0">
      <div className="text-danger">
        {error.severity}: {error.message}
        {error.sqlstate && <span className="ml-2 text-faint">{error.sqlstate}</span>}
      </div>
      {error.detail && <div className="text-muted">DETAIL: {error.detail}</div>}
      {error.hint && <div className="text-muted">HINT: {error.hint}</div>}
      {error.context && <div className="whitespace-pre-wrap text-dim">CONTEXT: {error.context}</div>}
    </div>
  );
}

function Body({ body }: { body: OutputBody }) {
  switch (body.kind) {
    case "Notice":
      return (
        <div className="min-w-0">
          <span className="text-muted">{body.severity}:</span> <span className="text-fg">{body.message}</span>
          {body.detail && <div className="text-dim">DETAIL: {body.detail}</div>}
        </div>
      );
    case "Command":
      return (
        <span className="text-fg">
          {body.tag} <span className="text-dim">· {formatElapsed(body.elapsedMs)}</span>
        </span>
      );
    case "Rows":
      return (
        <span className="text-fg">
          {pluralRows(body.rows)} <span className="text-dim">· {formatElapsed(body.elapsedMs)}</span>
          {body.truncated && <span className="text-dim"> · truncated at the row limit</span>}
        </span>
      );
    case "Error":
      return <ErrorBody error={body.error} />;
    case "Info":
      return <span className="text-dim">{body.message}</span>;
    default: {
      const unreachable: never = body;
      return unreachable;
    }
  }
}

export function OutputLog({ tabId }: { tabId: TabId }) {
  const entries = useLive((s) => s.output[tabId] ?? EMPTY);
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [entries.length]);

  if (entries.length === 0) {
    return <div className="grid flex-1 place-items-center bg-results text-[13px] text-dim">Notices, command results, and errors appear here.</div>;
  }
  return (
    <div ref={log} data-testid="output-log" className="selectable min-h-0 flex-1 overflow-auto bg-results py-2 font-mono text-[12.5px] leading-5">
      {entries.map((e, i) => (
        <div
          key={i}
          data-testid="output-line"
          data-kind={e.body.kind}
          className={cx("flex gap-4 px-4 py-0.5", e.body.kind === "Error" && "bg-danger/[0.04]")}
        >
          <span className="shrink-0 text-faint tabular-nums">{clock(e.atMs)}</span>
          <span className="w-6 shrink-0 text-faint">
            {"statement" in e.body && e.body.statement !== null ? `#${e.body.statement + 1}` : ""}
          </span>
          <Body body={e.body} />
        </div>
      ))}
    </div>
  );
}

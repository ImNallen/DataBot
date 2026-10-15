import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { OutputEntry, QueryError } from "../../ipc/bindings";
import { OUTPUT_LIMIT } from "../../state/live";
import { cx } from "../../ui/primitives";
import { formatClock, formatElapsed, groupDigits, pluralRows } from "./format";

export function ErrorBlock({ error, label }: { error: QueryError; label?: ReactNode }) {
  return (
    <>
      <div className="text-danger">
        {label}
        {error.message}
      </div>
      {error.detail && <div className="text-muted">{error.detail}</div>}
      {error.hint && <div className="text-muted">Hint: {error.hint}</div>}
      {error.context && <div className="whitespace-pre-wrap text-dim">Context: {error.context}</div>}
      {error.sqlstate && <div className="font-mono text-ui-11.5 text-faint">SQLSTATE {error.sqlstate}</div>}
    </>
  );
}

function Label({ className, children }: { className: string; children: ReactNode }) {
  return <span className={cx("mr-2", className)}>{children}</span>;
}

function LineBody({ body }: { body: OutputEntry["body"] }) {
  switch (body.kind) {
    case "Statement":
      return (
        <div className="text-fg">
          <Label className="text-dim">&gt;</Label>
          {body.text}
        </div>
      );
    case "Rows":
      return (
        <div className="text-dim">
          {pluralRows(body.rows)}
          {body.truncated && " (truncated)"} · {formatElapsed(body.elapsedMs)}
        </div>
      );
    case "Command":
      return (
        <div className="text-dim">
          {body.tag} · {formatElapsed(body.elapsedMs)}
        </div>
      );
    case "Notice":
      return (
        <>
          <div className="text-fg">
            <Label className={body.severity === "WARNING" ? "text-amber" : "text-faint"}>{body.severity}:</Label>
            {body.message}
          </div>
          {body.detail && <div className="text-dim">{body.detail}</div>}
        </>
      );
    case "Error":
      return <ErrorBlock error={body.error} label={<Label className="text-danger">ERROR:</Label>} />;
    case "Info":
      return <div className="text-dim">{body.message}</div>;
    default: {
      const unreachable: never = body;
      return unreachable;
    }
  }
}

function severityOf(body: OutputEntry["body"]): string | undefined {
  if (body.kind === "Notice") return body.severity;
  if (body.kind === "Error") return body.error.severity;
  return undefined;
}

type LineProps = { time: string; runStart: boolean; kind?: OutputEntry["body"]["kind"]; severity?: string; children: ReactNode };

function Line({ time, runStart, kind, severity, children }: LineProps) {
  return (
    <div
      data-testid={kind && "output-line"}
      data-kind={kind}
      data-severity={severity}
      className={cx("flex gap-4 px-5 [contain-intrinsic-size:auto_1.25rem] [content-visibility:auto]", runStart && "mt-2 border-t border-grid pt-2")}>
      <span className="w-[8ch] shrink-0 text-faint">{time}</span>
      <div className="min-w-0 flex-1 whitespace-pre-wrap">{children}</div>
    </div>
  );
}

/** The tab's whole output log, oldest first. Stays at the bottom while lines arrive unless the user scrolled up. */
export function OutputPanel({ entries }: { entries: readonly OutputEntry[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div
      ref={ref}
      data-testid="output-panel"
      className="selectable min-h-0 flex-1 overflow-auto bg-results py-3 font-mono text-ui-12.5 leading-5"
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
      }}
    >
      {entries.length === OUTPUT_LIMIT && (
        <Line time="" runStart={false}>
          <div className="text-dim">Only the last {groupDigits(String(OUTPUT_LIMIT))} lines are kept.</div>
        </Line>
      )}
      {entries.map((entry, i) => (
        <Line
          key={i}
          kind={entry.body.kind}
          severity={severityOf(entry.body)}
          time={formatClock(entry.atMs)}
          runStart={i > 0 && entries[i - 1]!.runId !== entry.runId}
        >
          <LineBody body={entry.body} />
        </Line>
      ))}
    </div>
  );
}

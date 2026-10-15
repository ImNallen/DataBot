import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { OutputEntry, QueryError } from "../../ipc/bindings";
import { OUTPUT_LIMIT } from "../../state/live";
import { cx } from "../../ui/primitives";
import { groupDigits } from "./format";

export function ErrorBlock({ error }: { error: QueryError }) {
  return (
    <>
      <div className="text-danger">{error.message}</div>
      {error.detail && <div className="text-muted">{error.detail}</div>}
      {error.hint && <div className="text-muted">Hint: {error.hint}</div>}
      {error.context && <div className="whitespace-pre-wrap text-dim">Context: {error.context}</div>}
      {error.sqlstate && <div className="font-mono text-ui-11.5 text-faint">SQLSTATE {error.sqlstate}</div>}
    </>
  );
}

type LineProps = { kind?: OutputEntry["body"]["kind"]; severity?: string; labelClass?: string; children: ReactNode };

function Line({ kind, severity, labelClass, children }: LineProps) {
  return (
    <div
      data-testid={kind && "message-line"}
      data-kind={kind}
      data-severity={severity}
      className="flex gap-3 px-5 [contain-intrinsic-size:auto_1.5rem] [content-visibility:auto]"
    >
      <span className={cx("w-16 shrink-0 font-mono text-ui-11.5", labelClass)}>{severity}</span>
      <div className="min-w-0 flex-1 whitespace-pre-wrap">{children}</div>
    </div>
  );
}

function MessageLine({ entry }: { entry: OutputEntry }) {
  const { body } = entry;
  switch (body.kind) {
    case "Notice":
      return (
        <Line kind="Notice" severity={body.severity} labelClass={body.severity === "WARNING" ? "text-amber" : "text-faint"}>
          <div className="text-fg">{body.message}</div>
          {body.detail && <div className="text-dim">{body.detail}</div>}
        </Line>
      );
    case "Info":
      return (
        <Line kind="Info">
          <div className="text-dim">{body.message}</div>
        </Line>
      );
    case "Error":
      return (
        <Line kind="Error" severity={body.error.severity} labelClass="text-danger">
          <ErrorBlock error={body.error} />
        </Line>
      );
    default: {
      const unreachable: never = body;
      return unreachable;
    }
  }
}

/** Stays scrolled to the newest entry unless the user scrolled up. Rows skip paint off screen, so no virtualizer up to the cap. */
export function MessagesPanel({ entries, dropped, tail }: { entries: OutputEntry[]; dropped: boolean; tail: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div
      ref={ref}
      data-testid="messages-panel"
      className="selectable min-h-0 flex-1 overflow-auto bg-results py-3 text-ui-13 leading-6"
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
      }}
    >
      {dropped && (
        <Line>
          <div className="text-dim">Only the last {groupDigits(String(OUTPUT_LIMIT))} messages are kept.</div>
        </Line>
      )}
      {entries.map((entry, i) => (
        <MessageLine key={i} entry={entry} />
      ))}
      <Line>
        <div className="text-dim">{tail}</div>
      </Line>
    </div>
  );
}

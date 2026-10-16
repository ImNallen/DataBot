import { IconChevronRight, IconCircleOff, IconDatabaseSearch, IconPlayerPlay, IconTable, IconTool } from "@tabler/icons-react";
import { memo, useState, type ReactNode } from "react";
import type { ApprovalId, ApprovalReason, ChatId, DatabaseRef, ToolResult, ToolStatus, ToolUse } from "../../ipc/bindings";
import { toolLine } from "../../state/transcript";
import { Button, cx, Spinner } from "../../ui/primitives";
import { answerApproval, openInNewTab } from "./assistantActions";
import { SqlHighlight } from "./SqlHighlight";

type RowsResult = Extract<ToolResult, { kind: "Rows" }>;

const TOOL_ICONS = { DescribeTables: IconTable, SearchCatalog: IconDatabaseSearch, RunQuery: IconPlayerPlay, Other: IconTool } satisfies Record<ToolUse["kind"], unknown>;

const PREVIEW_ROWS = 8;

function RowsPreview({ rows, sql, db }: { rows: RowsResult; sql: string | null; db: DatabaseRef | null }) {
  const shown = rows.rows.slice(0, PREVIEW_ROWS);
  const hidden = rows.rows.length - shown.length;
  return (
    <div className="mt-1.5 ml-5 overflow-hidden rounded-lg border border-control">
      <div className="max-h-56 overflow-auto">
        <table className="w-full border-collapse font-mono text-code-sm tabular-nums">
          <thead>
            <tr className="font-sans text-ui-12 text-muted">
              {rows.columns.map((c, i) => (
                <th key={i} className="sticky top-0 border-b border-control bg-bg px-2 py-1 text-left font-medium whitespace-nowrap">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, r) => (
              <tr key={r} className="border-t border-grid first:border-t-0">
                {row.map((cell, c) => (
                  <td key={c} className="max-w-[220px] truncate px-2 py-1 text-(color:--code)">
                    {cell ?? <span className="text-faint">NULL</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 border-t border-border px-2 py-1">
        <span className="flex-1 text-ui-11.5 text-dim">
          {hidden > 0 || rows.more ? `First ${shown.length} rows of what the assistant saw` : "Every row the assistant saw"}
        </span>
        {sql !== null && (
          <Button data-testid="tool-open-in-tab" variant="ghost" className="h-6 px-2 text-ui-12" onClick={() => openInNewTab(sql, db)}>
            Open in tab
          </Button>
        )}
      </div>
    </div>
  );
}

function ApprovalCard({ chatId, testId, tool, approval, reason }: { chatId: ChatId; testId: string; tool: ToolUse; approval: ApprovalId; reason: ApprovalReason }) {
  const [answered, setAnswered] = useState(false);
  const answer = (decision: "Run" | "Deny") => {
    setAnswered(true);
    void answerApproval(chatId, approval, decision);
  };
  return (
    <div data-testid={testId} className="flex flex-col gap-2 rounded-lg border border-accent-border px-3 py-2.5">
      <p className="text-ui-12.5 font-medium text-fg">{tool.kind === "RunQuery" ? "Run this query?" : "Allow this tool call?"}</p>
      {tool.kind === "RunQuery" && (
        <>
          {tool.purpose && <p className="text-ui-12.5 text-muted">{tool.purpose}</p>}
          <SqlHighlight sql={tool.sql} className="rounded-md border border-border bg-bg px-2.5 py-2" />
          {tool.relations.length > 0 && <p className="text-ui-12 text-dim">Uses {tool.relations.join(", ")}</p>}
        </>
      )}
      {reason.kind === "Unvetted" && <p className="text-ui-12 text-amber">Calls functions L1 Data cannot verify as read-only: {reason.functions.join(", ")}</p>}
      <div className="flex gap-1.5 pt-0.5">
        <Button data-testid="approval-run" variant="primary" className="h-7 px-3 text-ui-12.5" disabled={answered} onClick={() => answer("Run")}>
          Run
        </Button>
        <Button data-testid="approval-deny" className="h-7 px-3 text-ui-12.5" disabled={answered} onClick={() => answer("Deny")}>
          Deny
        </Button>
      </div>
    </div>
  );
}

function StatusIcon({ tool, status }: { tool: ToolUse; status: ToolStatus }): ReactNode {
  if (status.kind === "Running") return <Spinner />;
  if (status.kind === "Denied" || status.kind === "Expired" || status.kind === "Failed") return <IconCircleOff size={13} />;
  const Icon = TOOL_ICONS[tool.kind];
  return <Icon size={13} />;
}

export const ToolCard = memo(function ToolCard({ chatId, seq, tool, status, db }: { chatId: ChatId; seq: number; tool: ToolUse; status: ToolStatus; db: DatabaseRef | null }) {
  const [open, setOpen] = useState(false);
  const testId = `chat-tool-${seq}`;
  if (status.kind === "AwaitingApproval") return <ApprovalCard chatId={chatId} testId={testId} tool={tool} approval={status.approval} reason={status.reason} />;
  const rows = status.kind === "Done" && status.result.kind === "Rows" ? status.result : null;
  const line = toolLine(tool, status);
  return (
    <div data-testid={testId}>
      <button
        type="button"
        disabled={!rows}
        aria-expanded={rows ? open : undefined}
        title={tool.kind === "RunQuery" ? tool.purpose || line : line}
        onClick={() => setOpen((o) => !o)}
        className={cx("flex w-full min-w-0 items-center gap-2 rounded-md text-left text-ui-12.5 text-dim", rows && "hover:text-muted")}
      >
        <span className="grid w-3.5 shrink-0 place-items-center">
          <StatusIcon tool={tool} status={status} />
        </span>
        <span className="min-w-0 truncate">{line}</span>
        {rows && <IconChevronRight size={12} className={cx("shrink-0 transition-transform", open && "rotate-90")} />}
      </button>
      {open && rows && <RowsPreview rows={rows} sql={tool.kind === "RunQuery" ? tool.sql : null} db={db} />}
    </div>
  );
});

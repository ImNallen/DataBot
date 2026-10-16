import { IconCheck, IconCopy, IconPlayerPlayFilled } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { DatabaseRef } from "../../ipc/bindings";
import { useWorkspace } from "../../state/workspace";
import { Button, IconButton } from "../../ui/primitives";
import { insertSql, openInNewTab, replaceTabSql, runInNewTab } from "./assistantActions";
import { SqlHighlight } from "./SqlHighlight";

const ACTION = "h-7 px-2.5 text-ui-12.5";

export function SqlCard({ sql, relations, writes, complete, db }: { sql: string; relations: string[]; writes: boolean; complete: boolean; db: DatabaseRef | null }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
    } catch (e) {
      useWorkspace.getState().notify(`Could not copy: ${String(e)}`);
    }
  };
  return (
    <div data-testid="sql-card" className="overflow-hidden rounded-lg border border-control">
      <div className="flex h-8 items-center gap-2 border-b border-border pr-1 pl-3">
        <span className="font-mono text-ui-9.5 font-bold tracking-tight text-badge">SQL</span>
        {relations.length > 0 && (
          <span data-testid="sql-card-uses" className="min-w-0 truncate text-ui-12 text-dim">
            Uses {relations.join(", ")}
          </span>
        )}
        <div className="flex-1" />
        <IconButton data-testid="sql-card-copy" aria-label="Copy SQL" title={copied ? "Copied" : "Copy SQL"} className="size-6" disabled={!complete} onClick={() => void copy()}>
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
        </IconButton>
      </div>
      <SqlHighlight sql={sql} className="px-3 py-2.5" />
      <div className="flex flex-wrap items-center gap-1 border-t border-border px-2 py-1.5">
        {writes ? (
          <Button data-testid="sql-open-new-tab" title="Writes data, so it opens without running" className={ACTION} disabled={!complete} onClick={() => openInNewTab(sql, db)}>
            Open in new tab
          </Button>
        ) : (
          <Button data-testid="sql-run-new-tab" className={ACTION} disabled={!complete} onClick={() => runInNewTab(sql, db)}>
            <IconPlayerPlayFilled size={11} className="text-run-icon" />
            Run in new tab
          </Button>
        )}
        <Button data-testid="sql-insert" variant="ghost" className={ACTION} disabled={!complete} onClick={() => insertSql(sql)}>
          Insert at cursor
        </Button>
        <Button data-testid="sql-replace" variant="ghost" className={ACTION} disabled={!complete} onClick={() => replaceTabSql(sql)}>
          Replace tab
        </Button>
      </div>
    </div>
  );
}

import { useLive } from "../state/live";
import { connectionStatus } from "../state/status";
import { tabConnectionId, useWorkspace } from "../state/workspace";
import { StatusDot } from "../ui/primitives";

export function StatusBar() {
  const tab = useWorkspace((s) => (s.active ? s.tabs[s.active] : undefined));
  const cursor = useWorkspace((s) => s.cursor);
  const connectionId = tabConnectionId(tab);
  const config = useWorkspace((s) => (connectionId ? s.configs[connectionId] : undefined));
  const conn = useLive((s) => (connectionId ? s.connections[connectionId] : undefined));
  const liveConsole = useLive((s) => (tab ? s.consoles[tab.id] : undefined));
  const status = connectionStatus(conn);
  const schema = tab?.kind === "sql" ? (tab.console.schema ?? "public") : tab?.schema;
  const mode = tab?.kind === "sql" ? tab.console.mode : "AutoCommit";
  const txn = liveConsole?.txn;

  return (
    <footer className="flex h-[29px] shrink-0 items-center gap-5 border-t border-border px-4 text-[11.5px] text-dim">
      <span data-testid="status-connection" data-tone={status.tone} className="flex items-center gap-2">
        <StatusDot tone={config ? status.tone : "off"} />
        {config ? status.label : "No connection"}
      </span>
      {status.version && <span>PostgreSQL {status.version}</span>}
      {config && schema && <span>{`${config.database}.${schema}`}</span>}
      {liveConsole?.session.kind === "Lost" && liveConsole.session.txnLost && (
        <span className="text-danger">Transaction rolled back: connection lost</span>
      )}
      <span className="flex-1" />
      {tab?.kind === "sql" && <span>{`Ln ${cursor.line}, Col ${cursor.col}`}</span>}
      <span>UTF-8</span>
      <span>
        {mode === "Manual" ? "Manual" : "Auto-commit"}
        {mode === "Manual" && txn && txn !== "Idle" && <span className={txn === "Aborted" ? "text-danger" : "text-fg"}> · {txn === "Aborted" ? "aborted" : "in transaction"}</span>}
      </span>
    </footer>
  );
}

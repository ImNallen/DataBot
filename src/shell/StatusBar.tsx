import * as Menu from "@radix-ui/react-dropdown-menu";
import type { TxnMode } from "../ipc/bindings";
import { setTabMode } from "../features/editor/runActions";
import { useLive } from "../state/live";
import { connectionStatus } from "../state/status";
import { tabConnectionId, useWorkspace } from "../state/workspace";
import { MenuContent, MenuItem, StatusDot } from "../ui/primitives";

const MODE_LABEL: Record<TxnMode, string> = { AutoCommit: "Auto-commit", Manual: "Manual" };

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
      {tab?.kind === "sql" ? (
        <Menu.Root modal={false}>
          <Menu.Trigger data-testid="tx-mode" className="-mx-1.5 rounded px-1.5 py-0.5 outline-none hover:bg-hover hover:text-fg data-[state=open]:bg-hover">
            {MODE_LABEL[mode]}
            {mode === "Manual" && txn && txn !== "Idle" && <span className={txn === "Aborted" ? "text-danger" : "text-fg"}> · {txn === "Aborted" ? "aborted" : "in transaction"}</span>}
          </Menu.Trigger>
          <MenuContent align="end">
            {(["AutoCommit", "Manual"] as const).map((m) => (
              <MenuItem key={m} testId={`tx-mode-${m}`} checked={m === mode} onSelect={() => void setTabMode(tab.id, m)}>
                {MODE_LABEL[m]}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu.Root>
      ) : (
        <span>{MODE_LABEL[mode]}</span>
      )}
    </footer>
  );
}

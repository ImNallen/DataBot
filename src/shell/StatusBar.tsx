import * as Menu from "@radix-ui/react-dropdown-menu";
import type { TxnMode } from "../ipc/bindings";
import { setTabMode } from "../features/editor/runActions";
import { useLive } from "../state/live";
import { connectionStatus } from "../state/status";
import { tabTarget, targetLabel, useWorkspace } from "../state/workspace";
import { cx, MenuContent, MenuItem, StatusDot } from "../ui/primitives";

const CHIP = "inline-flex h-6 items-center gap-1.5 rounded-md bg-pill px-2";

const MODE_LABEL: Record<TxnMode, string> = { AutoCommit: "Auto-commit", Manual: "Manual" };

export function StatusBar() {
  const tab = useWorkspace((s) => (s.active ? s.tabs[s.active] : undefined));
  const cursor = useWorkspace((s) => s.cursor);
  const target = tabTarget(tab);
  const configs = useWorkspace((s) => s.configs);
  const config = target ? configs[target.connectionId] : undefined;
  const conn = useLive((s) => (target ? s.connections[target.connectionId] : undefined));
  const liveConsole = useLive((s) => (tab ? s.consoles[tab.id] : undefined));
  const status = connectionStatus(conn);
  const mode = tab?.kind === "sql" ? tab.console.mode : "AutoCommit";
  const txn = liveConsole?.txn;

  return (
    <footer className="flex h-9 shrink-0 items-center gap-1.5 px-2 text-ui-11.5 text-dim">
      <span data-testid="status-connection" data-tone={status.tone} className={CHIP}>
        <StatusDot tone={config ? status.tone : "off"} />
        {config ? status.label : "No connection"}
      </span>
      {target && config && (
        <span data-testid="status-target" className={CHIP}>
          {targetLabel(target, configs)}
        </span>
      )}
      {status.version && <span className={CHIP}>PostgreSQL {status.version}</span>}
      {liveConsole?.session.kind === "Lost" && liveConsole.session.txnLost && (
        <span className={cx(CHIP, "text-danger")}>Transaction rolled back: connection lost</span>
      )}
      <span className="flex-1" />
      {tab?.kind === "sql" && <span className={CHIP}>{`Ln ${cursor.line}, Col ${cursor.col}`}</span>}
      <span className={CHIP}>UTF-8</span>
      {tab?.kind === "sql" ? (
        <Menu.Root modal={false}>
          <Menu.Trigger data-testid="tx-mode" className={cx(CHIP, "outline-none hover:bg-control hover:text-fg data-[state=open]:bg-control data-[state=open]:text-fg")}>
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
        <span className={CHIP}>{MODE_LABEL[mode]}</span>
      )}
    </footer>
  );
}

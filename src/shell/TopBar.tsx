import * as Menu from "@radix-ui/react-dropdown-menu";
import { IconChevronDown, IconPlayerPlayFilled, IconPlayerStopFilled } from "@tabler/icons-react";
import { ConnectionColorDot } from "../features/connections/connectionColors";
import { cancelActive, endTransaction, runOrChoose, setTabMode, setTabTarget } from "../features/editor/runActions";
import type { TxnMode } from "../ipc/bindings";
import { homeDb } from "../state/dbKey";
import { useLive } from "../state/live";
import { connectionTone, hasUncommittedWork, isRunning } from "../state/status";
import { tabTarget, useWorkspace } from "../state/workspace";
import { Button, Kbd, MenuContent, MenuItem, MenuLabel, StatusDot, cx } from "../ui/primitives";
import { SidebarToggle, WindowEdgeActions, windowEdgeInset, windowLeadingInset } from "./WindowEdgeActions";
import type { HostedWindow } from "./hostedWindow";

const MODE_LABEL: Record<TxnMode, string> = { AutoCommit: "Auto-commit", Manual: "Manual" };

export function TopBar({ hosted }: { hosted: HostedWindow | null }) {
  const tab = useWorkspace((s) => (s.active ? s.tabs[s.active] : undefined));
  const configs = useWorkspace((s) => s.configs);
  const layout = useWorkspace((s) => s.layout);
  const connectionId = tabTarget(tab)?.connectionId ?? null;
  const liveConsole = useLive((s) => (tab ? s.consoles[tab.id] : undefined));
  const connections = useLive((s) => s.connections);
  const config = connectionId ? configs[connectionId] : undefined;
  const running = isRunning(liveConsole);
  const txn = liveConsole?.txn;
  const txnLost = liveConsole?.session.kind === "Lost" && liveConsole.session.txnLost;

  return (
    <header
      data-tauri-drag-region="deep"
      className={cx(
        "flex h-[52px] shrink-0 items-center gap-2",
        windowEdgeInset(hosted),
        layout.sidebar ? "pl-4" : windowLeadingInset(hosted),
      )}
    >
      {!layout.sidebar && <SidebarToggle />}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {tab ? (
          <Menu.Root modal={false}>
            <Menu.Trigger data-testid="tab-connection" className="flex min-w-0 items-center gap-1.5 rounded px-0.5 text-ui-14 text-dim outline-none hover:text-fg">
              <ConnectionColorDot color={config?.color ?? null} />
              <span className="truncate">{config?.name ?? "No connection"}</span>
            </Menu.Trigger>
            <MenuContent>
              <MenuLabel>Connection for this tab</MenuLabel>
              {Object.values(configs).map((c) => (
                <MenuItem key={c.id} checked={c.id === connectionId} onSelect={() => void setTabTarget(tab.id, homeDb(c))}>
                  <StatusDot tone={connectionTone(connections[c.id])} />
                  <ConnectionColorDot color={c.color} />
                  {c.name}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu.Root>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5 text-ui-14 text-dim">
            <ConnectionColorDot color={config?.color ?? null} />
            <span className="truncate">{config?.name ?? ""}</span>
          </span>
        )}
        {tab && (
          <>
            <span className="text-ui-14 text-faint">/</span>
            <span className="truncate text-ui-14 font-medium text-fg">{tab.title}</span>
          </>
        )}
      </div>

      {tab && (
        <Menu.Root modal={false}>
          <Menu.Trigger
            data-testid="tx-mode"
            title={txnLost ? "Transaction rolled back: connection lost" : undefined}
            className="inline-flex h-7 items-center gap-1 rounded-md pr-1.5 pl-2 text-ui-12.5 text-muted outline-none hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg"
          >
            {MODE_LABEL[tab.console.mode]}
            {tab.console.mode === "Manual" && txn && txn !== "Idle" && (
              <span className={txn === "Aborted" ? "text-danger" : "text-fg"}> · {txn === "Aborted" ? "aborted" : "in transaction"}</span>
            )}
            {txnLost && <span className="text-danger"> · rolled back</span>}
            <IconChevronDown size={13} />
          </Menu.Trigger>
          <MenuContent align="end">
            {(["AutoCommit", "Manual"] as const).map((m) => (
              <MenuItem key={m} testId={`tx-mode-${m}`} checked={m === tab.console.mode} onSelect={() => void setTabMode(tab.id, m)}>
                {MODE_LABEL[m]}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu.Root>
      )}

      {tab && hasUncommittedWork(liveConsole) && (
        <>
          <Button data-testid="commit-btn" disabled={running} onClick={() => void endTransaction(tab.id, "commit")}>
            Commit
          </Button>
          <Button data-testid="rollback-btn" disabled={running} onClick={() => void endTransaction(tab.id, "rollback")}>
            Rollback
          </Button>
        </>
      )}

      {tab &&
        (running ? (
          <Button data-testid="cancel-btn" className="w-[104px] justify-center bg-hover" onClick={() => cancelActive()}>
            <IconPlayerStopFilled size={10} className="text-muted" />
            Cancel
            <Kbd className="bg-control text-muted">Esc</Kbd>
          </Button>
        ) : (
          <Button
            data-testid="run-btn"
            variant="primary"
            title="Run the selection or the marked statement (⌘↵). On a blank line, or with ⌘⇧↵, choose which statement to run."
            className="w-[104px] justify-center pr-2 pl-2.5 font-medium"
            onClick={() => void runOrChoose()}
          >
            <IconPlayerPlayFilled size={13} className="text-run-icon" />
            Run
            <Kbd className="bg-run-fg/15 text-run-fg/85">⌘↵</Kbd>
          </Button>
        ))}

      {layout.rightPanel === null && (
        <>
          <div className="mx-1 h-5 w-px bg-border" />
          <WindowEdgeActions hosted={hosted} />
        </>
      )}
    </header>
  );
}

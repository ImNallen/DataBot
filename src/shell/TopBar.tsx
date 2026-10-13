import * as Menu from "@radix-ui/react-dropdown-menu";
import { IconPlayerPlayFilled, IconPlayerStopFilled } from "@tabler/icons-react";
import { cancelActive, endTransaction, runActive, setTabConnection } from "../features/editor/runActions";
import { useLive } from "../state/live";
import { connectionStatus, hasUncommittedWork, isRunning } from "../state/status";
import { tabConnectionId, tabLabel, useWorkspace } from "../state/workspace";
import { Button, Kbd, MenuContent, MenuItem, MenuLabel, StatusDot, cx } from "../ui/primitives";
import { SidebarToggle, WindowEdgeActions, windowEdgeInset, windowLeadingInset } from "./WindowEdgeActions";
import type { HostedWindow } from "./hostedWindow";

export function TopBar({ hosted }: { hosted: HostedWindow | null }) {
  const tab = useWorkspace((s) => (s.active ? s.tabs[s.active] : undefined));
  const configs = useWorkspace((s) => s.configs);
  const layout = useWorkspace((s) => s.layout);
  const connectionId = tabConnectionId(tab);
  const liveConsole = useLive((s) => (tab ? s.consoles[tab.id] : undefined));
  const connections = useLive((s) => s.connections);
  const config = connectionId ? configs[connectionId] : undefined;
  const running = isRunning(liveConsole);
  const sql = tab?.kind === "sql" ? tab : undefined;

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
        {sql ? (
          <Menu.Root modal={false}>
            <Menu.Trigger data-testid="tab-connection" className="truncate rounded px-0.5 text-[14px] text-dim outline-none hover:text-fg">
              {config?.name ?? "No connection"}
            </Menu.Trigger>
            <MenuContent>
              <MenuLabel>Connection for this tab</MenuLabel>
              {Object.values(configs).map((c) => (
                <MenuItem key={c.id} checked={c.id === connectionId} onSelect={() => void setTabConnection(sql.id, c.id)}>
                  <StatusDot tone={connectionStatus(connections[c.id]).tone} />
                  {c.name}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu.Root>
        ) : (
          <span className="truncate text-[14px] text-dim">{config?.name ?? ""}</span>
        )}
        {tab && (
          <>
            <span className="text-[14px] text-faint">/</span>
            <span className="truncate text-[14px] font-medium text-fg">{tabLabel(tab)}</span>
          </>
        )}
      </div>


      {sql && hasUncommittedWork(liveConsole) && (
        <>
          <Button data-testid="commit-btn" disabled={running} onClick={() => void endTransaction(sql.id, "commit")}>
            Commit
          </Button>
          <Button data-testid="rollback-btn" disabled={running} onClick={() => void endTransaction(sql.id, "rollback")}>
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
          <Button data-testid="run-btn" variant="primary" className="w-[104px] justify-center pr-2 pl-2.5 font-medium" onClick={() => runActive()}>
            <IconPlayerPlayFilled size={13} className="text-green" />
            Run
            <Kbd className="bg-white/15 text-[#dbe5fd]">⌘↵</Kbd>
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

import * as Menu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, Play, RefreshCw, Square } from "lucide-react";
import { cancelActive, endTransaction, runActive, setTabConnection, setTabSchema } from "../features/editor/runActions";
import { useCatalog } from "../state/catalog";
import { useLive } from "../state/live";
import { connectionStatus, hasUncommittedWork, isRunning } from "../state/status";
import { tabConnectionId, tabLabel, useWorkspace } from "../state/workspace";
import { Button, Kbd, MenuContent, MenuItem, MenuLabel, PgBadge, StatusDot, cx } from "../ui/primitives";
import { SidebarToggle, WindowEdgeActions, windowEdgeInset, windowLeadingInset } from "./WindowEdgeActions";
import type { HostedWindow } from "./hostedWindow";

function Dropdown({ children, testId, label, disabled }: { children: React.ReactNode; testId: string; label: React.ReactNode; disabled?: boolean }) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        data-testid={testId}
        disabled={disabled}
        className="inline-flex h-8 items-center gap-2 rounded-lg border border-control px-2.5 text-[13px] text-fg outline-none hover:bg-hover disabled:opacity-40 data-[state=open]:bg-hover"
      >
        {label}
        <ChevronDown size={14} className="text-muted" />
      </Menu.Trigger>
      {children}
    </Menu.Root>
  );
}

export function TopBar({ hosted }: { hosted: HostedWindow | null }) {
  const tab = useWorkspace((s) => (s.active ? s.tabs[s.active] : undefined));
  const configs = useWorkspace((s) => s.configs);
  const layout = useWorkspace((s) => s.layout);
  const connectionId = tabConnectionId(tab);
  const liveConsole = useLive((s) => (tab ? s.consoles[tab.id] : undefined));
  const connections = useLive((s) => s.connections);
  const catalog = useCatalog((s) => (connectionId ? s.views[connectionId]?.catalog : undefined));
  const config = connectionId ? configs[connectionId] : undefined;
  const running = isRunning(liveConsole);
  const sql = tab?.kind === "sql" ? tab : undefined;
  const schema = sql ? (sql.console.schema ?? "public") : tab?.kind === "table" ? tab.schema : null;
  const database = catalog?.database ?? config?.database;

  return (
    <header
      data-tauri-drag-region="deep"
      className={cx(
        "flex h-[52px] shrink-0 items-center gap-2 border-b border-border",
        windowEdgeInset(hosted),
        layout.sidebar ? "pl-4" : windowLeadingInset(hosted),
      )}
    >
      {!layout.sidebar && <SidebarToggle />}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <PgBadge />
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

      {sql && (
        <Dropdown
          testId="schema-picker"
          disabled={!catalog}
          label={
            <span className="flex items-baseline gap-1.5">
              <span className="text-dim">Schema</span>
              <span>{database ? `${database}.${schema}` : schema}</span>
            </span>
          }
        >
          <MenuContent>
            {catalog?.schemas.map((s) => (
              <MenuItem key={s.name} checked={s.name === schema} onSelect={() => void setTabSchema(sql.id, s.name)}>
                {s.name}
                <span className="ml-auto pl-4 text-[11.5px] text-dim">{s.relations.length}</span>
              </MenuItem>
            ))}
          </MenuContent>
        </Dropdown>
      )}

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
            <Square size={10} fill="currentColor" className="text-muted" />
            Cancel
            <Kbd className="bg-control text-muted">Esc</Kbd>
          </Button>
        ) : (
          <Button data-testid="run-btn" variant="primary" className="w-[104px] justify-center pr-2 pl-2.5 font-medium" onClick={() => runActive()}>
            {tab.kind === "table" ? <RefreshCw size={13} /> : <Play size={13} fill="currentColor" className="text-green" />}
            {tab.kind === "table" ? "Reload" : "Run"}
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

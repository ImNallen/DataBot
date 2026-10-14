import { IconAdjustmentsHorizontal, IconClock, IconPlus, IconSearch } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useWorkspace } from "../../state/workspace";
import { cx, IconButton, Kbd } from "../../ui/primitives";
import type { HostedWindow } from "../../shell/hostedWindow";
import { SidebarToggle, windowLeadingInset } from "../../shell/WindowEdgeActions";
import { ConnectionTree } from "./ConnectionTree";

export function SidebarHeader({ hosted }: { hosted: HostedWindow | null }) {
  return (
    <div data-tauri-drag-region="deep" className={cx("flex h-[52px] shrink-0 items-center gap-2 pr-3", windowLeadingInset(hosted))}>
      <SidebarToggle />
      <span data-testid="app-title" className="min-w-0 flex-1 truncate text-[14px] tracking-[-0.01em] text-tree">
        <span className="font-semibold">L1</span> <span className="font-normal text-muted">Data</span>
      </span>
    </div>
  );
}

export function SidebarSearch({ testId, label, onOpen, children }: { testId: string; label: string; onOpen: () => void; children?: ReactNode }) {
  return (
    <div className="mx-2 flex h-[34px] shrink-0 items-center gap-1">
      <button
        type="button"
        data-testid={testId}
        onClick={onOpen}
        className="group flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md pr-1.5 pl-2.5 text-left text-muted outline-none hover:bg-hover hover:text-fg"
      >
        <IconSearch size={15} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[13.5px]">{label}</span>
        <Kbd className="bg-border text-muted opacity-0 group-hover:opacity-100">⌘P</Kbd>
      </button>
      {children}
    </div>
  );
}

export function Sidebar({ hosted }: { hosted: HostedWindow | null }) {
  const open = useWorkspace((s) => s.open);
  const openSettings = useWorkspace((s) => s.openSettings);

  return (
    <aside className="flex h-full flex-col bg-sidebar">
      <SidebarHeader hosted={hosted} />

      <SidebarSearch testId="search-open" label="Search" onOpen={() => open({ kind: "palette" })}>
        <IconButton
          data-testid="new-connection"
          aria-label="New connection"
          onClick={() => open({ kind: "connection", editing: null })}
        >
          <IconPlus size={17} />
        </IconButton>
      </SidebarSearch>

      <ConnectionTree />

      <div className="mx-2 flex shrink-0 items-center gap-1 py-2">
        <IconButton
          data-testid="open-settings"
          aria-label="Settings"
          title="Settings"
          onClick={() => openSettings()}
        >
          <IconAdjustmentsHorizontal size={16} />
        </IconButton>
        <IconButton
          data-testid="open-history"
          aria-label="Query history"
          title="Query history"
          onClick={() => open({ kind: "history" })}
        >
          <IconClock size={16} />
        </IconButton>
      </div>
    </aside>
  );
}

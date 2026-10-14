import { IconAdjustmentsHorizontal, IconClock, IconPlus, IconSearch } from "@tabler/icons-react";
import { useWorkspace } from "../../state/workspace";
import { cx, IconButton, Kbd } from "../../ui/primitives";
import type { HostedWindow } from "../../shell/hostedWindow";
import { SidebarToggle, windowLeadingInset } from "../../shell/WindowEdgeActions";
import { ConnectionTree } from "./ConnectionTree";

export function Sidebar({ hosted }: { hosted: HostedWindow | null }) {
  const open = useWorkspace((s) => s.open);

  return (
    <aside className="flex h-full flex-col bg-sidebar">
      <div
        data-tauri-drag-region="deep"
        className={cx("flex h-[52px] shrink-0 items-center gap-2 pr-3", windowLeadingInset(hosted))}
      >
        <SidebarToggle />
        <span data-testid="app-title" className="min-w-0 flex-1 truncate text-[14px] tracking-[-0.01em] text-tree">
          <span className="font-semibold">L1</span> <span className="font-normal text-muted">Data</span>
        </span>
      </div>

      <div className="mx-2 flex h-[34px] shrink-0 items-center gap-1">
        <button
          type="button"
          data-testid="search-open"
          onClick={() => open({ kind: "palette" })}
          className="group flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md pr-1.5 pl-2.5 text-left text-muted outline-none hover:bg-hover hover:text-fg"
        >
          <IconSearch size={15} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[13.5px]">Search</span>
          <Kbd className="bg-border text-muted opacity-0 group-hover:opacity-100">⌘P</Kbd>
        </button>
        <IconButton
          data-testid="new-connection"
          aria-label="New connection"
          onClick={() => open({ kind: "connection", editing: null })}
        >
          <IconPlus size={17} />
        </IconButton>
      </div>

      <ConnectionTree />

      <div className="shrink-0 border-t border-hover py-2">
        <button
          type="button"
          data-testid="open-history"
          onClick={() => open({ kind: "history" })}
          className="mx-2 flex h-[29px] w-[calc(100%-16px)] items-center gap-2.5 rounded-md px-2.5 text-[14px] text-muted hover:bg-hover hover:text-fg"
        >
          <IconClock size={15} />
          Query history
        </button>
        <button
          type="button"
          data-testid="open-settings"
          onClick={() => open({ kind: "settings" })}
          className="mx-2 flex h-[29px] w-[calc(100%-16px)] items-center gap-2.5 rounded-md px-2.5 text-[14px] text-muted hover:bg-hover hover:text-fg"
        >
          <IconAdjustmentsHorizontal size={15} />
          Settings
        </button>
      </div>
    </aside>
  );
}

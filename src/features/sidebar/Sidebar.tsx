import { Clock, Plus, Search, SlidersHorizontal } from "lucide-react";
import { useWorkspace } from "../../state/workspace";
import { cx, IconButton, Kbd } from "../../ui/primitives";
import type { HostedWindow } from "../../shell/hostedWindow";
import { SidebarToggle, windowLeadingInset } from "../../shell/WindowEdgeActions";
import { ConnectionTree } from "./ConnectionTree";

export function Sidebar({ hosted }: { hosted: HostedWindow | null }) {
  const count = useWorkspace((s) => Object.keys(s.configs).length);
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
        <IconButton
          data-testid="new-connection"
          aria-label="New connection"
          onClick={() => open({ kind: "connection", editing: null })}
        >
          <Plus size={17} />
        </IconButton>
      </div>

      <button
        type="button"
        data-testid="search-open"
        onClick={() => open({ kind: "palette" })}
        className="mx-2 flex h-[34px] shrink-0 items-center gap-2.5 rounded-lg border border-control bg-bg pr-1.5 pl-3 text-left outline-none hover:border-[#262626]"
      >
        <Search size={15} className="shrink-0 text-green" />
        <span className="min-w-0 flex-1 truncate text-[13.5px] text-[#757575]">Search</span>
        <Kbd className="bg-border text-muted">⌘P</Kbd>
      </button>

      <div className="flex h-10 shrink-0 items-center justify-between px-[18px] pt-2 text-[12.5px] text-muted">
        <span>Connections</span>
        <span className="tabular-nums">{count}</span>
      </div>

      <ConnectionTree />

      <div className="shrink-0 border-t border-hover py-2">
        <button
          type="button"
          data-testid="open-history"
          onClick={() => open({ kind: "history" })}
          className="mx-2 flex h-[29px] w-[calc(100%-16px)] items-center gap-2.5 rounded-md px-2.5 text-[14px] text-muted hover:bg-hover hover:text-fg"
        >
          <Clock size={15} />
          Query history
        </button>
        <button
          type="button"
          data-testid="open-settings"
          onClick={() => open({ kind: "settings" })}
          className="mx-2 flex h-[29px] w-[calc(100%-16px)] items-center gap-2.5 rounded-md px-2.5 text-[14px] text-muted hover:bg-hover hover:text-fg"
        >
          <SlidersHorizontal size={15} />
          Settings
        </button>
      </div>
    </aside>
  );
}

import { IconAdjustmentsHorizontal, IconClock, IconPlus } from "@tabler/icons-react";
import { useWorkspace, type Screen } from "../../state/workspace";
import { cx, IconButton } from "../../ui/primitives";
import type { HostedWindow } from "../../shell/hostedWindow";
import { SidebarToggle, windowLeadingInset } from "../../shell/WindowEdgeActions";
import { SettingsSidebarBody } from "../settings/SettingsSidebarBody";
import { ConnectionTree } from "./ConnectionTree";
import { SidebarSearch } from "./SidebarSearch";

function SidebarHeader({ hosted }: { hosted: HostedWindow | null }) {
  return (
    <div data-tauri-drag-region="deep" className={cx("flex h-[52px] shrink-0 items-center gap-2 pr-3", windowLeadingInset(hosted))}>
      <SidebarToggle />
      <span data-testid="app-title" className="min-w-0 flex-1 truncate text-ui-14 tracking-[-0.01em] text-tree">
        <span className="font-semibold">L1</span> <span className="font-normal text-muted">Data</span>
      </span>
    </div>
  );
}

export function Sidebar({ hosted }: { hosted: HostedWindow | null }) {
  const screen = useWorkspace((s) => s.screen);
  return (
    <aside data-testid="sidebar-root" className="flex h-full flex-col bg-sidebar">
      <SidebarHeader hosted={hosted} />
      {sidebarBody(screen)}
    </aside>
  );
}

function sidebarBody(screen: Screen) {
  switch (screen.kind) {
    case "workspace":
      return <WorkspaceSidebarBody />;
    case "settings":
      return <SettingsSidebarBody section={screen.section} />;
    default: {
      const unreachable: never = screen;
      return unreachable;
    }
  }
}

function WorkspaceSidebarBody() {
  const open = useWorkspace((s) => s.open);
  const openSettings = useWorkspace((s) => s.openSettings);

  return (
    <>
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
    </>
  );
}

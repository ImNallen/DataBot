import { IconAdjustmentsHorizontal, IconChartBar, IconClock, IconPlus } from "@tabler/icons-react";
import { useMemo } from "react";
import { useCatalog } from "../../state/catalog";
import { useLive } from "../../state/live";
import { useWorkspace, type Screen } from "../../state/workspace";
import { cx, IconButton } from "../../ui/primitives";
import { parseQuery } from "../../ui/textMatch";
import type { HostedWindow } from "../../shell/hostedWindow";
import { SidebarToggle, windowLeadingInset } from "../../shell/WindowEdgeActions";
import { openTableTab } from "../editor/runActions";
import { SettingsSidebarBody } from "../settings/SettingsSidebarBody";
import { ConnectionTree } from "./ConnectionTree";
import { SidebarSearch } from "./SidebarSearch";
import { filterTree, firstRelation, type TreeFilter } from "./treeFilter";

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
      return <SettingsSidebarBody section={screen.section} query={screen.query} />;
    default: {
      const unreachable: never = screen;
      return unreachable;
    }
  }
}

function useTreeFilter(query: string): TreeFilter | null {
  const configs = useWorkspace((s) => s.configs);
  const connections = useLive((s) => s.connections);
  const views = useCatalog((s) => s.views);
  return useMemo(() => {
    const tokens = parseQuery(query);
    return tokens.length > 0 ? filterTree(tokens, configs, connections, views) : null;
  }, [query, configs, connections, views]);
}

function WorkspaceSidebarBody() {
  const open = useWorkspace((s) => s.open);
  const openSettings = useWorkspace((s) => s.openSettings);
  const query = useWorkspace((s) => s.treeQuery);
  const setTreeQuery = useWorkspace((s) => s.setTreeQuery);
  const filter = useTreeFilter(query);
  const openFirst = () => {
    const first = filter && firstRelation(filter, parseQuery(query));
    if (first) openTableTab(first);
  };

  return (
    <>
      <SidebarSearch testId="sidebar-search" query={query} count={filter?.count ?? 0} onQueryChange={setTreeQuery} onEnter={openFirst}>
        <IconButton
          data-testid="new-connection"
          aria-label="New connection"
          onClick={() => open({ kind: "connection", editing: null })}
        >
          <IconPlus size={17} />
        </IconButton>
      </SidebarSearch>

      <ConnectionTree filter={filter} query={query} />

      <div className="mx-2 flex shrink-0 items-center gap-1 py-2">
        <IconButton
          data-testid="open-settings"
          aria-label="Settings"
          title="Settings"
          onClick={() => openSettings()}
        >
          <IconAdjustmentsHorizontal size={16} />
        </IconButton>
        <IconButton data-testid="open-usage" aria-label="Usage" title="Usage" onClick={() => openSettings("usage")}>
          <IconChartBar size={16} />
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

import { PanelBottom, PanelLeft, PanelRight } from "lucide-react";
import { useWorkspace } from "../state/workspace";
import { IconButton } from "../ui/primitives";
import { WindowControls } from "./WindowChrome";
import type { HostedWindow } from "./hostedWindow";

export function windowEdgeInset(hosted: HostedWindow | null): string {
  return hosted?.chrome === "custom" ? "pr-2" : "pr-3";
}

// The macOS traffic lights (traffic_light_position 18,28 in src-tauri) end at x=77; 86px leaves the same gap they leave between each other.
export function windowLeadingInset(hosted: HostedWindow | null): string {
  return hosted?.chrome === "native" ? "pl-[86px]" : "pl-3";
}

// Lives in whichever header touches the window's left edge, so it never moves when the sidebar opens or closes.
export function SidebarToggle() {
  const sidebar = useWorkspace((s) => s.layout.sidebar);
  const setLayout = useWorkspace((s) => s.setLayout);
  return (
    <IconButton
      data-testid="toggle-sidebar"
      aria-label="Toggle sidebar"
      active={sidebar}
      className="shrink-0"
      onClick={() => setLayout({ sidebar: !sidebar })}
    >
      <PanelLeft size={16} />
    </IconButton>
  );
}

// Lives in whichever header touches the window's right edge, so it never moves when the right panel opens.
export function WindowEdgeActions({ hosted }: { hosted: HostedWindow | null }) {
  const results = useWorkspace((s) => s.layout.results);
  const rightPanel = useWorkspace((s) => s.layout.rightPanel);
  const setLayout = useWorkspace((s) => s.setLayout);
  return (
    <div className="flex items-center gap-2">
      <IconButton
        data-testid="toggle-results"
        aria-label="Toggle results"
        active={results}
        onClick={() => setLayout({ results: !results })}
      >
        <PanelBottom size={16} />
      </IconButton>
      <IconButton
        data-testid="toggle-right-panel"
        aria-label="Toggle right panel"
        active={rightPanel !== null}
        onClick={() => setLayout({ rightPanel: rightPanel ? null : "Assistant" })}
      >
        <PanelRight size={16} />
      </IconButton>
      {hosted?.chrome === "custom" && (
        <>
          <div className="mx-1 h-5 w-px bg-border" />
          <WindowControls hosted={hosted} />
        </>
      )}
    </div>
  );
}

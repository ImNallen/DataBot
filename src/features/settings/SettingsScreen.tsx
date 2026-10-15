import { useEffect } from "react";
import type { HostedWindow } from "../../shell/hostedWindow";
import { WindowControls } from "../../shell/WindowChrome";
import { SidebarToggle, windowEdgeInset, windowLeadingInset } from "../../shell/WindowEdgeActions";
import { useWorkspace, type Screen } from "../../state/workspace";
import { cx } from "../../ui/primitives";
import { parseQuery } from "../../ui/textMatch";
import { SearchResults, SectionBody } from "./sections";
import { filterSettings, sectionLabel } from "./settingsIndex";

/** Escape clears a settings search, back to the section it started on, and otherwise leaves settings. */
function useEscape() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { overlay, screen, closeSettings, setSettingsQuery } = useWorkspace.getState();
      if (e.key !== "Escape" || e.defaultPrevented || overlay.kind !== "none") return;
      if (screen.kind === "settings" && screen.query) setSettingsQuery("");
      else closeSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

type SettingsScreen = Extract<Screen, { kind: "settings" }>;

export function SettingsPage({ hosted, screen }: { hosted: HostedWindow | null; screen: SettingsScreen }) {
  useEscape();
  const tokens = parseQuery(screen.query);
  const matches = tokens.length > 0 ? filterSettings(tokens) : null;
  const sidebar = useWorkspace((s) => s.layout.sidebar);
  return (
    <div data-testid="settings-page" className="flex min-h-0 flex-1 flex-col">
      <header
        data-tauri-drag-region="deep"
        className={cx("flex h-[52px] shrink-0 items-center gap-2", windowEdgeInset(hosted), sidebar ? "pl-4" : windowLeadingInset(hosted))}
      >
        {!sidebar && <SidebarToggle />}
        <h1 data-testid="settings-breadcrumb" className="flex min-w-0 flex-1 items-center gap-2 text-ui-14">
          <span className="truncate px-0.5 text-dim">Settings</span>
          <span className="text-faint">/</span>
          <span className="truncate font-medium text-fg">{matches ? "Search results" : sectionLabel(screen.section)}</span>
        </h1>
        {hosted?.chrome === "custom" && <WindowControls hosted={hosted} />}
      </header>
      <div className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable_both-edges]">
        <div className="mx-auto max-w-[640px] px-8 pt-6 pb-16">
          {matches ? <SearchResults query={screen.query.trim()} matches={matches} /> : <SectionBody section={screen.section} />}
        </div>
      </div>
    </div>
  );
}

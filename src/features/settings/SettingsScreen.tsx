import { useEffect, useRef } from "react";
import type { HostedWindow } from "../../shell/hostedWindow";
import { WindowControls } from "../../shell/WindowChrome";
import { SidebarToggle, windowEdgeInset, windowLeadingInset } from "../../shell/WindowEdgeActions";
import { useWorkspace, type Screen } from "../../state/workspace";
import { cx } from "../../ui/primitives";
import { SectionBody } from "./sections";
import { sectionLabel } from "./settingsIndex";

function useEscapeToLeave() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { overlay, closeSettings } = useWorkspace.getState();
      if (e.key === "Escape" && !e.defaultPrevented && overlay.kind === "none") closeSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

type SettingsScreen = Extract<Screen, { kind: "settings" }>;

function useRevealTarget(screen: SettingsScreen) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!screen.target) return;
    const row = body.current?.querySelector(`[data-setting="${screen.target}"]`);
    row?.scrollIntoView({ block: "nearest" });
    (row?.querySelector<HTMLElement>("input:checked") ?? row?.querySelector<HTMLElement>("input, select"))?.focus({ preventScroll: true });
  }, [screen]);
  return body;
}

export function SettingsPage({ hosted, screen }: { hosted: HostedWindow | null; screen: SettingsScreen }) {
  useEscapeToLeave();
  const body = useRevealTarget(screen);
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
          <span className="truncate font-medium text-fg">{sectionLabel(screen.section)}</span>
        </h1>
        {hosted?.chrome === "custom" && <WindowControls hosted={hosted} />}
      </header>
      <div className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable_both-edges]">
        <div ref={body} className="mx-auto max-w-[640px] px-8 pt-6 pb-16">
          <SectionBody section={screen.section} />
        </div>
      </div>
    </div>
  );
}

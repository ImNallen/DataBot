import { useEffect, useRef } from "react";
import type { HostedWindow } from "../../shell/hostedWindow";
import { WindowControls } from "../../shell/WindowChrome";
import { SidebarToggle, windowLeadingInset } from "../../shell/WindowEdgeActions";
import { useWorkspace, type Screen } from "../../state/workspace";
import { cx } from "../../ui/primitives";
import { settingsSection } from "./sections";

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
    (row?.querySelector<HTMLElement>("input:checked") ?? row?.querySelector<HTMLElement>("input"))?.focus({ preventScroll: true });
  }, [screen]);
  return body;
}

export function SettingsPage({ hosted, screen }: { hosted: HostedWindow | null; screen: SettingsScreen }) {
  useEscapeToLeave();
  const body = useRevealTarget(screen);
  const sidebar = useWorkspace((s) => s.layout.sidebar);
  const { label, Body } = settingsSection(screen.section);
  return (
    <div data-testid="settings-page" className="flex min-h-0 flex-1 flex-col">
      <header data-tauri-drag-region="deep" className="relative flex h-[52px] shrink-0 items-center">
        {!sidebar && (
          <div className={cx("absolute inset-y-0 left-0 flex items-center", windowLeadingInset(hosted))}>
            <SidebarToggle />
          </div>
        )}
        <div className="mx-auto w-full max-w-[640px] min-w-0 px-8">
          <h1 className="truncate text-[14px] font-medium text-fg">{label}</h1>
        </div>
        {hosted?.chrome === "custom" && (
          <div className="absolute inset-y-0 right-2 flex items-center">
            <WindowControls hosted={hosted} />
          </div>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable_both-edges]">
        <div ref={body} className="mx-auto max-w-[640px] px-8 pt-6 pb-16">
          <Body />
        </div>
      </div>
    </div>
  );
}

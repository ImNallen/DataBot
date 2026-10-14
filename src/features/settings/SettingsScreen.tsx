import { IconChevronLeft } from "@tabler/icons-react";
import { useEffect } from "react";
import type { HostedWindow } from "../../shell/hostedWindow";
import { WindowControls } from "../../shell/WindowChrome";
import { windowLeadingInset } from "../../shell/WindowEdgeActions";
import { useWorkspace } from "../../state/workspace";
import { cx } from "../../ui/primitives";
import { SETTINGS_SECTIONS, settingsSection, type SettingsSectionId } from "./sections";

export function SettingsNav({ hosted, section }: { hosted: HostedWindow | null; section: SettingsSectionId }) {
  const openSettings = useWorkspace((s) => s.openSettings);
  const closeSettings = useWorkspace((s) => s.closeSettings);
  return (
    <nav data-testid="settings-nav" aria-label="Settings" className="flex h-full flex-col bg-sidebar">
      <div data-tauri-drag-region="deep" className={cx("flex h-[52px] shrink-0 items-center pr-3", windowLeadingInset(hosted))}>
        <button
          type="button"
          data-testid="settings-back"
          onClick={closeSettings}
          className="flex h-7 items-center gap-1 rounded-md pr-2 pl-1 text-[13.5px] text-muted hover:bg-hover hover:text-fg"
        >
          <IconChevronLeft size={16} />
          Back to app
        </button>
      </div>
      <ul className="flex flex-col gap-0.5 pt-1">
        {SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) => (
          <li key={id}>
            <button
              type="button"
              data-testid={`settings-section-${id}`}
              aria-current={id === section ? "page" : undefined}
              onClick={() => openSettings(id)}
              className={cx(
                "mx-2 flex h-7 w-[calc(100%-16px)] items-center gap-2 rounded-md px-2 text-left text-[14px] text-tree",
                id === section ? "bg-selected" : "hover:bg-hover",
              )}
            >
              <Icon size={15} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

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

export function SettingsPage({ hosted, section }: { hosted: HostedWindow | null; section: SettingsSectionId }) {
  useEscapeToLeave();
  const { label, Body } = settingsSection(section);
  return (
    <div data-testid="settings-page" className="flex min-h-0 flex-1 flex-col">
      <header data-tauri-drag-region="deep" className="relative flex h-[52px] shrink-0 items-center">
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
        <div className="mx-auto max-w-[640px] px-8 pt-6 pb-16">
          <Body />
        </div>
      </div>
    </div>
  );
}

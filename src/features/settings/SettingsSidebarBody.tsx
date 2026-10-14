import { IconArrowLeft } from "@tabler/icons-react";
import { useWorkspace } from "../../state/workspace";
import { cx } from "../../ui/primitives";
import { SidebarSearch } from "../sidebar/SidebarSearch";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./sections";

export function SettingsSidebarBody({ section }: { section: SettingsSectionId }) {
  const openSettings = useWorkspace((s) => s.openSettings);
  const closeSettings = useWorkspace((s) => s.closeSettings);
  const open = useWorkspace((s) => s.open);
  return (
    <>
      <SidebarSearch testId="settings-search-open" label="Search" onOpen={() => open({ kind: "settings-search" })} />
      <nav data-testid="settings-nav" aria-label="Settings" className="min-h-0 flex-1 overflow-auto pt-1">
        <ul className="flex flex-col gap-0.5">
          {SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) => (
            <li key={id}>
              <button
                type="button"
                data-testid={`settings-section-${id}`}
                aria-current={id === section ? "page" : undefined}
                onClick={() => openSettings(id)}
                className={cx(
                  "mx-2 flex h-7 w-[calc(100%-16px)] items-center gap-2 rounded-md px-2 text-left text-ui-14 text-tree",
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
      <div className="mx-2 shrink-0 py-2">
        <button
          type="button"
          data-testid="settings-back"
          onClick={closeSettings}
          className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-ui-13.5 text-muted hover:bg-hover hover:text-fg"
        >
          <IconArrowLeft size={16} />
          Back
        </button>
      </div>
    </>
  );
}

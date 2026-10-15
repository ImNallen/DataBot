import { IconArrowLeft } from "@tabler/icons-react";
import { useWorkspace } from "../../state/workspace";
import { cx, Kbd } from "../../ui/primitives";
import { parseQuery } from "../../ui/textMatch";
import { SidebarSearch } from "../sidebar/SidebarSearch";
import { SECTION_ICONS } from "./sections";
import { filterSettings, SETTINGS_INDEX, type SettingsSectionId } from "./settingsIndex";

/** While `query` is set the nav lists only the sections with matches, each with its count, and none is current. */
export function SettingsSidebarBody({ section, query }: { section: SettingsSectionId; query: string }) {
  const openSettings = useWorkspace((s) => s.openSettings);
  const closeSettings = useWorkspace((s) => s.closeSettings);
  const setSettingsQuery = useWorkspace((s) => s.setSettingsQuery);
  const tokens = parseQuery(query);
  const matches = tokens.length > 0 ? filterSettings(tokens) : null;
  const sections = SETTINGS_INDEX.flatMap(({ id, label }) => {
    const count = matches?.filter((m) => m.section === id).length ?? null;
    return count === 0 ? [] : [{ id, label, count }];
  });
  return (
    <>
      <SidebarSearch testId="settings-search" query={query} count={matches?.length ?? 0} onQueryChange={setSettingsQuery} />
      {matches && (
        <p data-testid="settings-search-hint" className="mx-2 flex items-start gap-2 px-2 pt-1 pb-1.5 text-ui-11.5 leading-4 text-dim">
          <Kbd className="shrink-0 bg-border text-muted">esc</Kbd>
          clear and go back to the section you were on
        </p>
      )}
      <nav data-testid="settings-nav" aria-label="Settings" className="min-h-0 flex-1 overflow-auto pt-1">
        <ul className="flex flex-col gap-0.5">
          {sections.map(({ id, label, count }) => {
            const Icon = SECTION_ICONS[id];
            const current = !matches && id === section;
            return (
              <li key={id}>
                <button
                  type="button"
                  data-testid={`settings-section-${id}`}
                  aria-current={current ? "page" : undefined}
                  onClick={() => openSettings(id)}
                  className={cx(
                    "mx-2 flex h-7 w-[calc(100%-16px)] items-center gap-2 rounded-md px-2 text-left text-ui-14 text-tree",
                    current ? "bg-selected" : "hover:bg-hover",
                  )}
                >
                  <Icon size={15} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {count !== null && <span className="shrink-0 text-ui-11.5 text-muted tabular-nums">{count}</span>}
                </button>
              </li>
            );
          })}
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

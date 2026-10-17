import { IconChartBar, IconPalette, IconSparkles, IconSql, type Icon } from "@tabler/icons-react";
import type { ComponentType } from "react";
import { useWorkspace } from "../../state/workspace";
import { CodeFontSetting, DensitySetting, InterfaceFontSetting, PanelMotionSetting, TintConnectionsSetting } from "./AppearanceControls";
import { ColorSchemeSetting, ThemesSetting } from "./AppearanceSection";
import { HealthCheckSetting, ProviderListSetting } from "./ProvidersSection";
import { MaxRowsSetting, StopOnErrorSetting, TablePageSizeSetting } from "./QueriesSection";
import { Card } from "./SettingLayout";
import { UsageLimitsSetting, UsageRefresh } from "./UsageSection";
import { sectionLabel, sectionSettings, settingRuns, type SettingEntry, type SettingId, type SettingsSectionId } from "./settingsIndex";

export const SECTION_ICONS = { appearance: IconPalette, queries: IconSql, providers: IconSparkles, usage: IconChartBar } satisfies Record<SettingsSectionId, Icon>;

export const SECTION_ACTIONS: Partial<Record<SettingsSectionId, ComponentType>> = { usage: UsageRefresh };

const SETTING_VIEWS = {
  colorScheme: ColorSchemeSetting,
  themes: ThemesSetting,
  density: DensitySetting,
  panelMotion: PanelMotionSetting,
  tintConnections: TintConnectionsSetting,
  interfaceFont: InterfaceFontSetting,
  codeFont: CodeFontSetting,
  maxRows: MaxRowsSetting,
  tablePageSize: TablePageSizeSetting,
  stopOnError: StopOnErrorSetting,
  providerList: ProviderListSetting,
  providerHealthCheck: HealthCheckSetting,
  usageLimits: UsageLimitsSetting,
} satisfies Record<SettingId, ComponentType>;

export function SettingViews({ settings }: { settings: readonly SettingEntry[] }) {
  return settings.map(({ id }) => {
    const View = SETTING_VIEWS[id];
    return <View key={id} />;
  });
}

export function SectionBody({ section }: { section: SettingsSectionId }) {
  return (
    <div className="flex flex-col gap-8">
      {settingRuns(sectionSettings(section)).map((run) =>
        run.group === null ? (
          <SettingViews key={run.settings[0]?.id} settings={run.settings} />
        ) : (
          <Card key={run.group} title={run.group}>
            <SettingViews settings={run.settings} />
          </Card>
        ),
      )}
    </div>
  );
}

/** The settings that match a search, live, under a heading per section and card group. */
export function SearchResults({ query, matches }: { query: string; matches: readonly SettingEntry[] }) {
  const setSettingsQuery = useWorkspace((s) => s.setSettingsQuery);
  const n = matches.length;
  return (
    <div className="flex flex-col gap-6">
      <p data-testid="settings-search-summary" className="flex items-baseline gap-3 text-ui-13 text-dim">
        {n === 0 ? `No settings match “${query}”.` : `${n} ${n === 1 ? "setting matches" : "settings match"} “${query}”`}
        <button
          type="button"
          data-testid="settings-search-clear-results"
          onClick={() => setSettingsQuery("")}
          className="text-fg underline underline-offset-2 hover:text-fg/80"
        >
          Clear search
        </button>
      </p>
      {settingRuns(matches).map((run) => {
        const Icon = SECTION_ICONS[run.section];
        const title = (
          <>
            <Icon size={15} className="shrink-0 text-muted" />
            <span>
              {sectionLabel(run.section)}
              {run.group !== null && <span className="font-normal text-faint"> · {run.group}</span>}
            </span>
          </>
        );
        return (
          <Card key={`${run.section}/${run.group}/${run.settings[0]?.id}`} title={title} bare={run.group === null}>
            <SettingViews settings={run.settings} />
          </Card>
        );
      })}
    </div>
  );
}

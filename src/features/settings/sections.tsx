import { IconPalette, IconSql, type Icon } from "@tabler/icons-react";
import type { ComponentType } from "react";
import { CodeFontSetting, DensitySetting, InterfaceFontSetting, PanelMotionSetting } from "./AppearanceControls";
import { ColorSchemeSetting, ThemesSetting } from "./AppearanceSection";
import { MaxRowsSetting, StopOnErrorSetting, TablePageSizeSetting } from "./QueriesSection";
import { Card } from "./SettingLayout";
import { sectionSettings, settingRuns, type SettingEntry, type SettingId, type SettingsSectionId } from "./settingsIndex";

export const SECTION_ICONS = { appearance: IconPalette, queries: IconSql } satisfies Record<SettingsSectionId, Icon>;

const SETTING_VIEWS = {
  colorScheme: ColorSchemeSetting,
  themes: ThemesSetting,
  density: DensitySetting,
  panelMotion: PanelMotionSetting,
  interfaceFont: InterfaceFontSetting,
  codeFont: CodeFontSetting,
  maxRows: MaxRowsSetting,
  tablePageSize: TablePageSizeSetting,
  stopOnError: StopOnErrorSetting,
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

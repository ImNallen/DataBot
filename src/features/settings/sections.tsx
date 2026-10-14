import { IconPalette, IconSql, type Icon } from "@tabler/icons-react";
import type { ComponentType } from "react";
import { fuzzyRank } from "../sidebar/fuzzy";
import { AppearanceSection } from "./AppearanceSection";
import { QueriesSection } from "./QueriesSection";

type SettingsSection = {
  id: string;
  label: string;
  icon: Icon;
  Body: ComponentType;
  settings: readonly { id: string; label: string; keywords: string }[];
};

export const SETTINGS_SECTIONS = [
  {
    id: "appearance",
    label: "Appearance",
    icon: IconPalette,
    Body: AppearanceSection,
    settings: [{ id: "theme", label: "Theme", keywords: "appearance dark light system mode colour color" }],
  },
  {
    id: "queries",
    label: "Queries",
    icon: IconSql,
    Body: QueriesSection,
    settings: [
      { id: "maxRows", label: "Row limit per result", keywords: "max rows limit results" },
      { id: "tablePageSize", label: "Table page size", keywords: "rows per page paging browse" },
      { id: "stopOnError", label: "Stop a script at the first error", keywords: "errors script abort fail skip" },
    ],
  },
] as const satisfies readonly SettingsSection[];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
export type SettingId = (typeof SETTINGS_SECTIONS)[number]["settings"][number]["id"];

export function settingsSection(id: SettingsSectionId): SettingsSection {
  return SETTINGS_SECTIONS.find((s) => s.id === id) ?? SETTINGS_SECTIONS[0];
}

export type SettingEntry = { id: SettingId; label: string; keywords: string; section: SettingsSectionId; sectionLabel: string; icon: Icon };

const SETTINGS: readonly SettingEntry[] = SETTINGS_SECTIONS.flatMap(({ id: section, label: sectionLabel, icon, settings }) =>
  settings.map((s) => ({ ...s, section, sectionLabel, icon })),
);

export function searchSettings(query: string): readonly SettingEntry[] {
  return query.trim() ? fuzzyRank(query, SETTINGS, (s) => `${s.label} ${s.sectionLabel} ${s.keywords}`) : SETTINGS;
}

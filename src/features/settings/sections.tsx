import { IconPalette, IconSql, type Icon } from "@tabler/icons-react";
import type { ComponentType } from "react";
import { AppearanceSection } from "./AppearanceSection";
import { QueriesSection } from "./QueriesSection";

type SettingsSection = { id: string; label: string; icon: Icon; Body: ComponentType };

export const SETTINGS_SECTIONS = [
  { id: "appearance", label: "Appearance", icon: IconPalette, Body: AppearanceSection },
  { id: "queries", label: "Queries", icon: IconSql, Body: QueriesSection },
] as const satisfies readonly SettingsSection[];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export function settingsSection(id: SettingsSectionId): SettingsSection {
  return SETTINGS_SECTIONS.find((s) => s.id === id) ?? SETTINGS_SECTIONS[0];
}

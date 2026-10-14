import type { ColorScheme, CustomTheme, Settings } from "../../ipc/bindings";
import { useWorkspace } from "../../state/workspace";
import {
  APPEARANCES,
  customVariant,
  FIXED_APPEARANCE,
  L1_VARIANTS,
  SCHEME_FOR,
  THEME_SLOT,
  type ThemeDraft,
  type ThemeVariant,
} from "../../themes/catalog";
import { saveSettings } from "../editor/runActions";

const settings = () => useWorkspace.getState().settings;

export function chooseColorScheme(colorScheme: ColorScheme): Promise<void> {
  return saveSettings({ colorScheme });
}

/** Puts each variant in its appearance's slot, and switches a pinned scheme when it would hide every pick. */
function picksPatch(variants: readonly ThemeVariant[]): Partial<Settings> {
  const patch: Partial<Settings> = {};
  for (const v of variants) patch[THEME_SLOT[v.appearance]] = v.id;
  const pinned = FIXED_APPEARANCE[settings().colorScheme];
  const first = variants[0];
  if (first && pinned && !variants.some((v) => v.appearance === pinned)) patch.colorScheme = SCHEME_FOR[first.appearance];
  return patch;
}

export function chooseThemes(variants: readonly ThemeVariant[]): Promise<void> {
  return saveSettings(picksPatch(variants));
}

export function addCustomThemes(drafts: readonly ThemeDraft[]): Promise<void> {
  const added = drafts.map((d): CustomTheme => ({ id: `custom-${crypto.randomUUID()}`, name: d.name, appearance: d.appearance, colors: { ...d.colors } }));
  const firsts = APPEARANCES.flatMap((a) => added.find((t) => t.appearance === a) ?? []).map(customVariant);
  return saveSettings({ customThemes: [...settings().customThemes, ...added], ...picksPatch(firsts) });
}

export async function addThemes(drafts: readonly ThemeDraft[]): Promise<void> {
  await addCustomThemes(drafts);
  const names = drafts.map((d) => d.name);
  useWorkspace.getState().notify(names.length === 1 ? `Added ${names[0]}.` : `Added ${names.length} themes.`);
}

export function deleteCustomTheme(id: string): Promise<void> {
  const patch: Partial<Settings> = { customThemes: settings().customThemes.filter((t) => t.id !== id) };
  for (const a of APPEARANCES) if (settings()[THEME_SLOT[a]] === id) patch[THEME_SLOT[a]] = L1_VARIANTS[a].id;
  return saveSettings(patch);
}

export function confirmDeleteTheme(theme: Pick<CustomTheme, "id" | "name">): void {
  useWorkspace.getState().open({
    kind: "confirm",
    title: `Delete ${theme.name}?`,
    body: "The theme is removed from your themes. Modes using it go back to L1.",
    confirmLabel: "Delete",
    onConfirm: () => void deleteCustomTheme(theme.id),
  });
}

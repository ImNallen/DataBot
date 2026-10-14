import type { ColorScheme, CustomTheme, Settings } from "../../ipc/bindings";
import { useWorkspace } from "../../state/workspace";
import {
  APPEARANCES,
  customFamily,
  familyPicks,
  FIXED_APPEARANCE,
  L1_VARIANTS,
  SCHEME_FOR,
  THEME_SLOT,
  type ThemeFamilyDraft,
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

function stored(draft: ThemeFamilyDraft): CustomTheme {
  const id = `custom-${crypto.randomUUID()}`;
  const variants = draft.variants.map((v, i) => ({ id: `${id}-${i}`, name: v.name, appearance: v.appearance, colors: { ...v.colors } }));
  return { id, name: draft.name, variants };
}

/** Saves each family as one theme and picks the first light and first dark of the first one. */
export function addCustomThemes(drafts: readonly ThemeFamilyDraft[]): Promise<void> {
  const added = drafts.map(stored);
  const first = added[0] && customFamily(added[0]);
  return saveSettings({ customThemes: [...settings().customThemes, ...added], ...picksPatch(first ? familyPicks(first) : []) });
}

export async function addThemes(drafts: readonly ThemeFamilyDraft[]): Promise<void> {
  await addCustomThemes(drafts);
  const names = drafts.map((d) => d.name);
  useWorkspace.getState().notify(names.length === 1 ? `Added ${names[0]}.` : `Added ${names.length} themes.`);
}

export function deleteCustomTheme(familyId: string): Promise<void> {
  const themes = settings().customThemes;
  const gone = new Set(themes.find((t) => t.id === familyId)?.variants.map((v) => v.id));
  const patch: Partial<Settings> = { customThemes: themes.filter((t) => t.id !== familyId) };
  for (const a of APPEARANCES) if (gone.has(settings()[THEME_SLOT[a]])) patch[THEME_SLOT[a]] = L1_VARIANTS[a].id;
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

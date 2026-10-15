import { IconColorSwatch, IconCopy, IconMoon, IconPlus, IconSun, IconTrash } from "@tabler/icons-react";
import { useState, useSyncExternalStore } from "react";
import type { Appearance, ColorScheme } from "../../ipc/bindings";
import { useWorkspace } from "../../state/workspace";
import {
  draftOf,
  familyPicks,
  FIXED_APPEARANCE,
  pickedVariant,
  resolveTheme,
  THEME_SLOT,
  themeFamilies,
  type ThemeDraft,
  type ThemeFamily,
  type ThemeVariant,
} from "../../themes/catalog";
import { completePalette } from "../../themes/palette";
import { Button, cx, IconButton } from "../../ui/primitives";
import { AddThemeDialog } from "./AddThemeDialog";
import { CreateThemePanel } from "./CreateThemePanel";
import { SettingLabel } from "./SettingLayout";
import { chooseColorScheme, chooseThemes, confirmDeleteTheme } from "./themeActions";

function Swatch({ variant }: { variant: ThemeVariant }) {
  const c = completePalette(variant.appearance, { ...variant.palette, ...variant.swatch });
  const bar = (width: string, color = c.control) => <span className="h-1.5 rounded-full" style={{ width, background: color }} />;
  return (
    <span className="absolute inset-0 flex" style={{ background: c.background }}>
      <span className="flex w-[30%] flex-col gap-1.5 px-2 py-2.5" style={{ background: c.sidebar }}>
        {bar("80%")}
        {bar("55%")}
        {bar("68%")}
      </span>
      <span className="flex flex-1 flex-col gap-1.5 px-2.5 py-2.5">
        {bar("30%", c.accent)}
        {bar("75%")}
        {bar("52%")}
        {bar("64%")}
      </span>
    </span>
  );
}

const SCHEMES: ColorScheme[] = ["System", "Light", "Dark"];

function SchemePreview({ scheme, picks }: { scheme: ColorScheme; picks: Record<Appearance, ThemeVariant> }) {
  const fixed = FIXED_APPEARANCE[scheme];
  if (fixed) return <Swatch variant={picks[fixed]} />;
  return (
    <>
      <Swatch variant={picks.light} />
      <span className="absolute inset-0" style={{ clipPath: "polygon(58% 0, 100% 0, 100% 100%, 42% 100%)" }}>
        <Swatch variant={picks.dark} />
      </span>
    </>
  );
}

type OrbSize = { label: string; orb: string; badge: string; icon: number; gap: string };

// Sized so a row of orbs fits a card at the three-column grid's width; past four they wrap.
const ORB_SIZES = {
  large: { label: "size-[60px]", orb: "size-12", badge: "right-0 bottom-0 size-[18px]", icon: 11, gap: "gap-3" },
  medium: { label: "size-12", orb: "size-[38px]", badge: "-right-px -bottom-px size-4", icon: 10, gap: "gap-2" },
  small: { label: "size-9", orb: "size-[30px]", badge: "-right-0.5 -bottom-0.5 size-[15px]", icon: 9, gap: "gap-1.5" },
} as const satisfies Record<string, OrbSize>;

const orbSize = (count: number): OrbSize => (count <= 2 ? ORB_SIZES.large : count === 3 ? ORB_SIZES.medium : ORB_SIZES.small);

const ORB_ICON: Record<Appearance, typeof IconSun> = { light: IconSun, dark: IconMoon };

function Orb({ variant, checked, size }: { variant: ThemeVariant; checked: boolean; size: OrbSize }) {
  const { background, accent } = variant.swatch;
  const Icon = ORB_ICON[variant.appearance];
  return (
    <label title={variant.name} data-testid={`theme-orb-${variant.id}`} className={cx("relative grid cursor-pointer place-items-center rounded-full", size.label)}>
      <input
        type="radio"
        name={THEME_SLOT[variant.appearance]}
        value={variant.id}
        aria-label={variant.name}
        checked={checked}
        readOnly
        onClick={() => void chooseThemes([variant])}
        className="peer sr-only"
      />
      <span
        className={cx("rounded-full shadow-[inset_0_0_0_1px_rgb(127_127_127/0.25)] transition-transform hover:scale-105", size.orb)}
        style={{ background: `radial-gradient(circle at 32% 28%, ${background} 18%, ${accent} 100%)` }}
      />
      <span className="pointer-events-none absolute inset-0 rounded-full ring-run peer-checked:ring-2 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus peer-focus-visible:outline-solid" />
      {checked && (
        <span className={cx("absolute grid place-items-center rounded-full border border-control bg-bg text-fg", size.badge)}>
          <Icon size={size.icon} />
        </span>
      )}
    </label>
  );
}

type CardProps = { family: ThemeFamily; picks: Record<Appearance, string>; appearance: Appearance; onDuplicate: (draft: ThemeDraft) => void };

function ThemeCard({ family, picks, appearance, onDuplicate }: CardProps) {
  const { variants } = family;
  const size = orbSize(variants.length);
  const shown = variants.find((v) => v.id === picks[appearance]) ?? variants.find((v) => v.appearance === appearance) ?? variants[0];
  const both = new Set(variants.map((v) => v.appearance)).size > 1;
  return (
    <div data-testid={`theme-family-${family.id}`} className="group relative flex flex-col rounded-lg border border-control">
      <div className={cx("flex min-h-[88px] flex-1 flex-wrap content-center justify-center px-2 pt-4 pb-3", size.gap)}>
        {variants.map((v) => (
          <Orb key={v.id} variant={v} checked={picks[v.appearance] === v.id} size={size} />
        ))}
      </div>
      <div className="flex h-9 items-center px-1">
        <button
          type="button"
          title={both ? `Use ${family.name} for light and dark` : `Use ${family.name}`}
          onClick={() => void chooseThemes(familyPicks(family))}
          className="min-w-0 flex-1 truncate rounded-md px-2 py-1 text-left text-ui-13 text-fg hover:bg-hover"
        >
          {family.name}
        </button>
      </div>
      <div className="absolute top-1.5 right-1.5 flex opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        {shown && (
          <IconButton aria-label={`Duplicate ${shown.name}`} title="Duplicate into a new theme" onClick={() => onDuplicate(draftOf(shown, `${shown.name} copy`))}>
            <IconCopy size={14} />
          </IconButton>
        )}
        {family.custom && (
          <IconButton aria-label={`Delete ${family.name}`} title="Delete theme" onClick={() => confirmDeleteTheme(family)}>
            <IconTrash size={14} />
          </IconButton>
        )}
      </div>
    </div>
  );
}

const DARK_QUERY = "(prefers-color-scheme: dark)";
const subscribeSystem = (onChange: () => void) => {
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
};

export function ColorSchemeSetting() {
  const settings = useWorkspace((s) => s.settings);
  const variants = { light: pickedVariant(settings, "light"), dark: pickedVariant(settings, "dark") };
  return (
    <fieldset data-setting="colorScheme">
      <legend className="text-ui-13 font-medium text-fg">
        <SettingLabel id="colorScheme" />
      </legend>
      <p className="mt-0.5 text-ui-12 text-dim">System follows the appearance of your operating system.</p>
      <div className="mt-4 grid grid-cols-3 gap-3">
        {SCHEMES.map((scheme) => (
          <label key={scheme} data-testid={`scheme-${scheme}`} className="group flex flex-col gap-2">
            <input
              type="radio"
              name="colorScheme"
              value={scheme}
              checked={scheme === settings.colorScheme}
              onChange={() => void chooseColorScheme(scheme)}
              className="peer sr-only"
            />
            <span className="relative h-[88px] overflow-hidden rounded-lg border border-control transition-colors group-hover:border-handle-hover peer-checked:border-run peer-checked:ring-1 peer-checked:ring-run peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus peer-focus-visible:outline-solid">
              <SchemePreview scheme={scheme} picks={variants} />
            </span>
            <span className="text-ui-13 text-muted peer-checked:text-fg">{scheme}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ThemesSetting() {
  const settings = useWorkspace((s) => s.settings);
  const systemDark = useSyncExternalStore(subscribeSystem, () => window.matchMedia(DARK_QUERY).matches, () => true);
  const current = resolveTheme(settings, systemDark);
  const [draft, setDraft] = useState<{ key: number; draft: ThemeDraft } | null>(null);
  const [adding, setAdding] = useState(false);
  const edit = (next: ThemeDraft) => setDraft((d) => ({ key: (d?.key ?? 0) + 1, draft: next }));
  const families = themeFamilies(settings.customThemes);
  const picks = { light: settings.lightTheme, dark: settings.darkTheme };
  return (
    <section data-setting="themes" aria-labelledby="themes-heading">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 id="themes-heading" className="text-ui-13 font-medium text-fg">
            <SettingLabel id="themes" />
          </h2>
          <p className="mt-0.5 text-ui-12 text-dim">Pick one theme for light mode and one for dark.</p>
        </div>
        <div className="flex gap-2">
          <Button
            data-testid="create-theme"
            className="h-7 px-2.5 text-ui-12.5"
            onClick={() => edit(draftOf(current, ""))}
          >
            <IconColorSwatch size={14} />
            Create theme
          </Button>
          <Button data-testid="add-theme" className="h-7 px-2.5 text-ui-12.5" onClick={() => setAdding(true)}>
            <IconPlus size={14} />
            Add theme
          </Button>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3">
        {families.map((family) => (
          <ThemeCard key={family.id} family={family} picks={picks} appearance={current.appearance} onDuplicate={edit} />
        ))}
      </div>
      <AddThemeDialog open={adding} onOpenChange={setAdding} />
      {draft && <CreateThemePanel key={draft.key} initial={draft.draft} onClose={() => setDraft(null)} />}
    </section>
  );
}

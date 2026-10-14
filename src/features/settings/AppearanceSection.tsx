import { IconMoon, IconSun } from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { Appearance, ColorScheme, Settings } from "../../ipc/bindings";
import { useWorkspace } from "../../state/workspace";
import {
  APPEARANCES,
  FIXED_APPEARANCE,
  pickedVariant,
  SCHEME_FOR,
  THEME_SLOT,
  themeFamilies,
  type ThemeFamily,
  type ThemeVariant,
} from "../../themes/catalog";
import { derivePalette } from "../../themes/palette";
import { saveSettings } from "../editor/runActions";

function Swatch({ variant }: { variant: ThemeVariant }) {
  const c = { ...derivePalette(variant.appearance, variant.swatch.background, variant.swatch.accent), ...variant.palette };
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

export function chooseColorScheme(colorScheme: ColorScheme): Promise<void> {
  return saveSettings({ colorScheme });
}

/** Puts each variant in its appearance's slot, and switches a pinned scheme when it would hide every pick. */
export function chooseThemes(variants: readonly ThemeVariant[]): Promise<void> {
  const patch: Partial<Settings> = {};
  for (const v of variants) patch[THEME_SLOT[v.appearance]] = v.id;
  const pinned = FIXED_APPEARANCE[useWorkspace.getState().settings.colorScheme];
  const first = variants[0];
  if (first && pinned && !variants.some((v) => v.appearance === pinned)) patch.colorScheme = SCHEME_FOR[first.appearance];
  return saveSettings(patch);
}

const ORB_ICON: Record<Appearance, ReactNode> = { light: <IconSun size={11} />, dark: <IconMoon size={11} /> };

function Orb({ variant, checked }: { variant: ThemeVariant; checked: boolean }) {
  const { background, accent } = variant.swatch;
  return (
    <label title={variant.name} data-testid={`theme-orb-${variant.id}`} className="relative grid size-[60px] cursor-pointer place-items-center rounded-full">
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
        className="size-12 rounded-full shadow-[inset_0_0_0_1px_rgb(127_127_127/0.25)] transition-transform hover:scale-105"
        style={{ background: `radial-gradient(circle at 32% 28%, ${background} 18%, ${accent} 100%)` }}
      />
      <span className="pointer-events-none absolute inset-0 rounded-full ring-run peer-checked:ring-2 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus peer-focus-visible:outline-solid" />
      {checked && (
        <span className="absolute right-0 bottom-0 grid size-[18px] place-items-center rounded-full border border-control bg-bg text-fg">
          {ORB_ICON[variant.appearance]}
        </span>
      )}
    </label>
  );
}

function ThemeCard({ family, picks }: { family: ThemeFamily; picks: Record<Appearance, string> }) {
  const variants = APPEARANCES.flatMap((a) => family.variants[a] ?? []);
  return (
    <div data-testid={`theme-family-${family.id}`} className="flex flex-col rounded-lg border border-control">
      <div className="flex justify-center gap-3 px-3 pt-4 pb-3">
        {variants.map((v) => (
          <Orb key={v.id} variant={v} checked={picks[v.appearance] === v.id} />
        ))}
      </div>
      <div className="flex h-9 items-center gap-1 pr-1.5 pl-1">
        <button
          type="button"
          title={variants.length > 1 ? `Use ${family.name} for light and dark` : `Use ${family.name}`}
          onClick={() => void chooseThemes(variants)}
          className="min-w-0 flex-1 truncate rounded-md px-2 py-1 text-left text-[13px] text-fg hover:bg-hover"
        >
          {family.name}
        </button>
      </div>
    </div>
  );
}

export function AppearanceSection() {
  const settings = useWorkspace((s) => s.settings);
  const families = themeFamilies(settings.customThemes);
  const picks = { light: settings.lightTheme, dark: settings.darkTheme };
  const variants = { light: pickedVariant(settings, "light"), dark: pickedVariant(settings, "dark") };
  return (
    <div className="flex flex-col gap-8">
      <fieldset data-setting="colorScheme">
        <legend className="text-[13px] font-medium text-fg">Color scheme</legend>
        <p className="mt-0.5 text-[12px] text-dim">System follows the appearance of your operating system.</p>
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
              <span className="text-[13px] text-muted peer-checked:text-fg">{scheme}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <section data-setting="themes" aria-labelledby="themes-heading">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 id="themes-heading" className="text-[13px] font-medium text-fg">
              Themes
            </h2>
            <p className="mt-0.5 text-[12px] text-dim">Pick one theme for light mode and one for dark.</p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          {families.map((family) => (
            <ThemeCard key={family.id} family={family} picks={picks} />
          ))}
        </div>
      </section>
    </div>
  );
}

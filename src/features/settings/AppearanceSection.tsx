import type { ReactNode } from "react";
import type { Theme } from "../../ipc/bindings";
import type { Appearance } from "../../shell/theme";
import { useWorkspace } from "../../state/workspace";
import { saveSettings } from "../editor/runActions";

// Fixed colours: each preview shows its own theme whichever one is active.
const SWATCH: Record<Appearance, { bg: string; sidebar: string; line: string; accent: string }> = {
  light: { bg: "#ffffff", sidebar: "#f7f7f8", line: "#dcdcdf", accent: "#346bf1" },
  dark: { bg: "#0a0a0a", sidebar: "#000000", line: "#262626", accent: "#346bf1" },
};

function Swatch({ appearance }: { appearance: Appearance }) {
  const c = SWATCH[appearance];
  const bar = (width: string, color = c.line) => <span className="h-1.5 rounded-full" style={{ width, background: color }} />;
  return (
    <span className="absolute inset-0 flex" style={{ background: c.bg }}>
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

const PREVIEW: Record<Theme, ReactNode> = {
  System: (
    <>
      <Swatch appearance="light" />
      <span className="absolute inset-0" style={{ clipPath: "polygon(58% 0, 100% 0, 100% 100%, 42% 100%)" }}>
        <Swatch appearance="dark" />
      </span>
    </>
  ),
  Light: <Swatch appearance="light" />,
  Dark: <Swatch appearance="dark" />,
};

const THEMES: Theme[] = ["System", "Light", "Dark"];

export function chooseTheme(theme: Theme): Promise<void> {
  return saveSettings({ theme });
}

export function AppearanceSection() {
  const current = useWorkspace((s) => s.settings.theme);
  return (
    <fieldset>
      <legend className="text-[13px] font-medium text-fg">Theme</legend>
      <p className="mt-0.5 text-[12px] text-dim">System follows the appearance of your operating system.</p>
      <div className="mt-4 grid grid-cols-3 gap-3">
        {THEMES.map((theme) => (
          <label key={theme} data-testid={`theme-${theme}`} className="group flex flex-col gap-2">
            <input
              type="radio"
              name="theme"
              value={theme}
              checked={theme === current}
              onChange={() => void chooseTheme(theme)}
              className="peer sr-only"
            />
            <span className="relative h-[88px] overflow-hidden rounded-lg border border-control transition-colors group-hover:border-handle-hover peer-checked:border-run peer-checked:ring-1 peer-checked:ring-run peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus peer-focus-visible:outline-solid">
              {PREVIEW[theme]}
            </span>
            <span className="text-[13px] text-muted peer-checked:text-fg">{theme}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

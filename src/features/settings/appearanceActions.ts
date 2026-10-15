import type { Density, FontSetting } from "../../ipc/bindings";
import { useWorkspace } from "../../state/workspace";
import type { FontKind } from "../../themes/fonts";
import { saveSettings } from "../editor/runActions";

const FONT_FIELD = { interface: "interfaceFont", code: "codeFont" } as const satisfies Record<FontKind, string>;

export function chooseDensity(density: Density): Promise<void> {
  return saveSettings({ density });
}

export function chooseFont(kind: FontKind, change: Partial<FontSetting>): Promise<void> {
  const field = FONT_FIELD[kind];
  return saveSettings({ [field]: { ...useWorkspace.getState().settings[field], ...change } });
}

/** Paints a panel speed without saving it, so a slider drag repaints live and saves once on release. */
export function previewPanelMotion(panelMotionMs: number): void {
  const { settings, setSettings } = useWorkspace.getState();
  setSettings({ ...settings, panelMotionMs });
}

export function savePanelMotion(panelMotionMs: number): Promise<void> {
  return saveSettings({ panelMotionMs });
}

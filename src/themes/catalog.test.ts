import { expect, it } from "vitest";
import type { CustomTheme, CustomThemeVariant } from "../ipc/bindings";
import { BUILT_IN_FAMILIES, customVariant, draftOf, familyPicks, resolveTheme, themeFamilies, type ThemeSettings } from "./catalog";

const defaults: ThemeSettings = { colorScheme: "System", lightTheme: "l1-light", darkTheme: "l1-dark", customThemes: [] };
const duskVariant: CustomThemeVariant = { id: "custom-dusk", name: "Dusk", appearance: "dark", colors: { background: "#1b1824", accent: "#e0a040" } };
const dusk: CustomTheme = { id: "custom-dusk-family", name: "Dusk", variants: [duskVariant] };

it.each([
  ["System", true, "l1-dark"],
  ["System", false, "l1-light"],
  ["Light", true, "l1-light"],
  ["Dark", false, "l1-dark"],
] as const)("resolves the %s scheme with a dark system %s to %s by default", (colorScheme, systemDark, id) => {
  expect(resolveTheme({ ...defaults, colorScheme }, systemDark).id).toBe(id);
});

it("resolves the pick for the scheme's appearance", () => {
  const settings = { ...defaults, lightTheme: "ocean-light", darkTheme: "ember-dark" };
  expect([resolveTheme(settings, false).id, resolveTheme(settings, true).id]).toEqual(["ocean-light", "ember-dark"]);
});

it("falls back to L1 of the slot's appearance when the id is unknown or names the other appearance", () => {
  expect(resolveTheme({ ...defaults, darkTheme: "deleted-theme" }, true).id).toBe("l1-dark");
  expect(resolveTheme({ ...defaults, lightTheme: "grove-dark" }, false).id).toBe("l1-light");
  expect(resolveTheme({ ...defaults, lightTheme: "custom-dusk", customThemes: [dusk] }, false).id).toBe("l1-light");
});

it("resolves a custom theme to its stored colours over a palette derived from its background and accent", () => {
  const tuned = { ...duskVariant, colors: { ...duskVariant.colors, sidebar: "#000000", nope: "#fff" } };
  const variant = resolveTheme({ ...defaults, darkTheme: "custom-dusk", customThemes: [{ ...dusk, variants: [tuned] }] }, true);
  expect([variant.id, variant.name, variant.appearance]).toEqual(["custom-dusk", "Dusk", "dark"]);
  expect(variant.swatch).toEqual({ background: "#1b1824", accent: "#e0a040" });
  expect([variant.palette.background, variant.palette.accent, variant.palette.sidebar]).toEqual(["#1b1824", "#e0a040", "#000000"]);
  expect(variant.palette.foreground).toMatch(/^#[0-9a-f]{6}$/);
  expect(Object.keys(variant.palette)).not.toContain("nope");
});

it("paints L1 from the stylesheet with no inline palette", () => {
  expect(resolveTheme(defaults, true).palette).toEqual({});
  expect(resolveTheme(defaults, false).palette).toEqual({});
});

it("duplicates a variant as its seeds plus only the colours they don't derive", () => {
  const groveDark = BUILT_IN_FAMILIES.flatMap((f) => f.variants).find((v) => v.id === "grove-dark");
  expect(groveDark && draftOf(groveDark, "Grove copy")).toEqual({ name: "Grove copy", appearance: "dark", colors: { background: "#0c1310", accent: "#2f9e6e" } });
  const tuned = customVariant({ ...duskVariant, colors: { ...duskVariant.colors, keyword: "#ff00ff" } });
  expect(draftOf(tuned, "Dusk copy").colors).toEqual({ background: "#1b1824", accent: "#e0a040", keyword: "#ff00ff" });
});

const variant = (id: string, name: string, appearance: "light" | "dark", background: string): CustomThemeVariant => ({
  id,
  name,
  appearance,
  colors: { background, accent: "#cba6f7" },
});

const catppuccin: CustomTheme = {
  id: "custom-cat",
  name: "Catppuccin",
  variants: [
    variant("custom-cat-0", "Mocha", "dark", "#1e1e2e"),
    variant("custom-cat-1", "Latte", "light", "#eff1f5"),
    variant("custom-cat-2", "Frappe", "dark", "#303446"),
  ],
};

it("shows each stored theme as one family, light variants first, and skips a theme with no variants", () => {
  const customs = themeFamilies([catppuccin, { id: "custom-empty", name: "Empty", variants: [] }]).filter((f) => f.custom);
  expect(customs.map((f) => [f.id, f.name, f.variants.map((v) => v.id)])).toEqual([
    ["custom-cat", "Catppuccin", ["custom-cat-1", "custom-cat-0", "custom-cat-2"]],
  ]);
  expect(customs[0] && familyPicks(customs[0]).map((v) => v.id)).toEqual(["custom-cat-1", "custom-cat-0"]);
});

it("resolves any variant of a family for its own appearance only", () => {
  const settings = { ...defaults, lightTheme: "custom-cat-2", darkTheme: "custom-cat-2", customThemes: [catppuccin] };
  expect([resolveTheme(settings, false).id, resolveTheme(settings, true).id]).toEqual(["l1-light", "custom-cat-2"]);
});

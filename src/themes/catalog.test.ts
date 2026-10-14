import { expect, it } from "vitest";
import type { CustomTheme } from "../ipc/bindings";
import { BUILT_IN_FAMILIES, customVariant, draftOf, resolveTheme, type ThemeSettings } from "./catalog";

const defaults: ThemeSettings = { colorScheme: "System", lightTheme: "l1-light", darkTheme: "l1-dark", customThemes: [] };
const dusk: CustomTheme = { id: "custom-dusk", name: "Dusk", appearance: "dark", colors: { background: "#1b1824", accent: "#e0a040" } };

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
  const variant = resolveTheme({ ...defaults, darkTheme: "custom-dusk", customThemes: [{ ...dusk, colors: { ...dusk.colors, sidebar: "#000000", nope: "#fff" } }] }, true);
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
  const groveDark = BUILT_IN_FAMILIES.find((f) => f.id === "grove")?.variants.dark;
  expect(groveDark && draftOf(groveDark, "Grove copy")).toEqual({ name: "Grove copy", appearance: "dark", colors: { background: "#0c1310", accent: "#2f9e6e" } });
  const tuned = customVariant({ ...dusk, colors: { ...dusk.colors, keyword: "#ff00ff" } });
  expect(draftOf(tuned, "Dusk copy").colors).toEqual({ background: "#1b1824", accent: "#e0a040", keyword: "#ff00ff" });
});

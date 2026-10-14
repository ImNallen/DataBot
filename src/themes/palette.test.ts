import { expect, it } from "vitest";
import { BUILT_IN_FAMILIES } from "./catalog";
import { contrast, parseHex } from "./color";
import { derivePalette, TOKENS } from "./palette";

const derived = BUILT_IN_FAMILIES.flatMap((f) => f.variants).filter((v) => Object.keys(v.palette).length > 0);

const ratio = (x = "", y = "") => {
  const [p, q] = [parseHex(x), parseHex(y)];
  return p && q ? contrast(p, q) : 0;
};

it("derives a light and a dark variant for each of the five seeded families", () => {
  expect(derived.map((v) => v.id)).toEqual([
    "grove-light", "grove-dark", "ocean-light", "ocean-dark", "ember-light", "ember-dark", "iris-light", "iris-dark", "rose-light", "rose-dark",
  ]);
});

it.each(derived.map((v) => [v.id, v.palette] as const))("keeps %s text readable on its background and accent", (_, p) => {
  expect(ratio(p.foreground, p.background)).toBeGreaterThanOrEqual(7);
  expect(ratio(p.muted, p.background)).toBeGreaterThanOrEqual(4.5);
  expect(ratio(p.dim, p.background)).toBeGreaterThanOrEqual(3);
  expect(ratio(p.accentForeground, p.accent)).toBeGreaterThanOrEqual(3);
});

it("derives every token as hex, keeping the seeds verbatim", () => {
  const p = derivePalette("dark", "#0a0a0a", "#346bf1");
  expect(Object.keys(p).sort()).toEqual(Object.keys(TOKENS).sort());
  expect(Object.values(p).every((v) => /^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(v))).toBe(true);
  expect([p.background, p.accent]).toEqual(["#0a0a0a", "#346bf1"]);
});

it("puts dark text on a pale accent and white text on a deep one", () => {
  expect(derivePalette("dark", "#2e3440", "#88c0d0").accentForeground).not.toBe("#ffffff");
  expect(ratio(derivePalette("dark", "#2e3440", "#88c0d0").accentForeground, "#88c0d0")).toBeGreaterThanOrEqual(4.5);
  expect(derivePalette("light", "#ffffff", "#346bf1").accentForeground).toBe("#ffffff");
});

import { expect, it } from "vitest";
import { fontChoices, fontStack } from "./fonts";

it("resolves registry families to their stacks and keeps ui-monospace behind SF Mono by name", () => {
  expect(fontStack("interface", "Inter")).toBe('"Inter Variable", ui-sans-serif, system-ui, sans-serif');
  expect(fontStack("interface", "Avenir Next")).toBe('"Avenir Next", ui-sans-serif, system-ui, sans-serif');
  expect(fontStack("code", "SF Mono")).toBe('"SF Mono", SFMono-Regular, ui-monospace, Menlo, monospace');
});

it("passes an unknown saved family through ahead of the default fallbacks", () => {
  expect(fontStack("code", "Berkeley Mono")).toBe('"Berkeley Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace');
  expect(fontStack("interface", "Geist")).toBe('"Geist", ui-sans-serif, system-ui, sans-serif');
});

it("offers bundled and generic fonts always, others only when installed, and the saved family regardless", () => {
  const onlyMenlo = (probe: string) => probe === '"Menlo"';
  expect(fontChoices("code", "JetBrains Mono", onlyMenlo)).toEqual(["JetBrains Mono", "Menlo"]);
  expect(fontChoices("code", "Consolas", onlyMenlo)).toEqual(["JetBrains Mono", "Menlo", "Consolas"]);
  expect(fontChoices("code", "Berkeley Mono", () => false)).toEqual(["JetBrains Mono", "Berkeley Mono"]);
  expect(fontChoices("interface", "Inter", () => false)).toEqual(["Inter", "System"]);
});

it("off Apple platforms offers SF Mono only when the face is installed by name, not because ui-monospace resolves", () => {
  const onlyUiMonospace = (probe: string) => probe.startsWith("ui-monospace");
  expect(fontChoices("code", "JetBrains Mono", onlyUiMonospace)).toEqual(["JetBrains Mono"]);
  const byName = (probe: string) => probe === '"SF Mono", SFMono-Regular';
  expect(fontChoices("code", "JetBrains Mono", byName)).toEqual(["JetBrains Mono", "SF Mono"]);
});

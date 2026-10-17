import { expect, it } from "vitest";
import type { LimitsReport, LimitWindow } from "../../ipc/bindings";
import { checkedText, formatReset, nextReset } from "./usageText";

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const MIN = 60_000;

it.each([
  [null, null],
  [NOW - 1, "now"],
  [NOW, "now"],
  [NOW + 59_000, "0m"],
  [NOW + 26 * MIN, "26m"],
  [NOW + 86 * MIN, "1h 26m"],
  [NOW + (23 * 60 + 59) * MIN, "23h 59m"],
  [NOW + 24 * 60 * MIN, "1d 0h"],
  [NOW + (3 * 24 + 4) * 60 * MIN + 30_000, "3d 4h"],
])("counts down to a reset at %j as %j", (resetsAtMs, shown) => {
  expect(formatReset(resetsAtMs, NOW)).toBe(shown);
});

const window = (id: string, resetsAtMs: number | null): LimitWindow => ({ id, label: id, leftPercent: 50, resetsAtMs, level: "Normal" });

const report = (claude: LimitWindow[], codex: LimitWindow[]): LimitsReport => ({
  checkedAtMs: NOW,
  sources: [
    { source: "Claude", name: "Claude", outcome: { kind: "Ready", plan: "Max", windows: claude } },
    { source: "Codex", name: "Codex", outcome: { kind: "Ready", plan: "ChatGPT Pro", windows: codex } },
  ],
});

it("rereads at the first reset still ahead of the read, across every source", () => {
  expect(nextReset(report([window("session", NOW + 86 * MIN), window("weekly", NOW + 5000 * MIN)], [window("primary", NOW + 30 * MIN)]))).toBe(NOW + 30 * MIN);
  expect(nextReset(report([window("session", NOW - MIN), window("weekly", null)], []))).toBeNull();
  const missing: LimitsReport = { checkedAtMs: NOW, sources: [{ source: "Codex", name: "Codex", outcome: { kind: "NotFound", binary: "codex on PATH" } }] };
  expect(nextReset(missing)).toBeNull();
});

it("says Checking during a read, then how long ago the last read finished", () => {
  expect(checkedText(null, false, NOW)).toBe("");
  expect(checkedText(report([], []), true, NOW)).toBe("Checking…");
  expect(checkedText(report([], []), false, NOW + 2 * MIN)).toBe("Checked 2m ago");
});

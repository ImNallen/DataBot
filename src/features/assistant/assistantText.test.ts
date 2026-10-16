import { expect, it } from "vitest";
import type { ProbeOutcome, ProviderState } from "../../ipc/bindings";
import { checkedAgo, ignoredFlags, providerStatus } from "./assistantText";

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

const INFO = {
  defaultName: "Claude",
  defaultBinary: "claude",
  configEnv: "CLAUDE_CONFIG_DIR",
  configDirDefault: "~/.claude",
  signInCommand: "claude auth login",
  ownedFlags: ["--model", "--resume", "--output-format"],
};

function provider(outcome: ProbeOutcome | null, extra: Partial<ProviderState> = {}): ProviderState {
  return { provider: "Claude", rev: 1, info: INFO, checking: false, checkedAtMs: NOW - 90 * SEC, outcome, ...extra };
}

it("says how long ago the newest check finished, in whole minutes, hours, or days", () => {
  const at = (ago: number) => checkedAgo([provider(null, { checkedAtMs: NOW - ago })], NOW);
  expect([at(0), at(59 * SEC), at(60 * SEC), at(59 * MIN + 59 * SEC), at(HOUR), at(23 * HOUR + 59 * MIN), at(24 * HOUR), at(9 * 24 * HOUR)]).toEqual([
    "Checked just now",
    "Checked just now",
    "Checked 1m ago",
    "Checked 59m ago",
    "Checked 1h ago",
    "Checked 23h ago",
    "Checked 1d ago",
    "Checked 9d ago",
  ]);
});

it("reads the newest of several checks, says Checking while any probe runs, and admits when none has finished", () => {
  const old = provider(null, { checkedAtMs: NOW - 3 * HOUR });
  const recent = provider(null, { checkedAtMs: NOW - 4 * MIN });
  expect(checkedAgo([old, recent], NOW)).toBe("Checked 4m ago");
  expect(checkedAgo([old, { ...recent, checking: true }], NOW)).toBe("Checking…");
  expect(checkedAgo([provider(null, { checkedAtMs: null })], NOW)).toBe("Not checked yet");
  expect(checkedAgo([], NOW)).toBe("Not checked yet");
});

it("states each probe outcome under the provider's name, and keeps it on screen while the next probe runs", () => {
  const ready = (plan: string | null): ProbeOutcome => ({ kind: "Ready", version: "2.1.301", plan, models: [] });
  expect(
    [
      provider(ready("Claude Max")),
      provider(ready(null)),
      provider({ kind: "SignedOut", version: "2.1.301" }),
      provider({ kind: "NotFound", binary: "claude on PATH" }),
      provider({ kind: "Broken", version: "2.1.301", message: "auth status timed out after 5 s" }),
      provider(null, { checking: true, checkedAtMs: null }),
      provider(null, { checkedAtMs: null }),
      provider(ready("Claude Max"), { checking: true }),
      undefined,
    ].map(providerStatus),
  ).toEqual([
    { text: "Signed in · Claude Max", tone: "ok" },
    { text: "Signed in", tone: "ok" },
    { text: "Not signed in", tone: "warn" },
    { text: "Not found", tone: "error" },
    { text: "auth status timed out after 5 s", tone: "error" },
    { text: "Checking…", tone: "muted" },
    { text: "Not checked yet", tone: "muted" },
    { text: "Signed in · Claude Max", tone: "ok" },
    { text: "Not checked yet", tone: "muted" },
  ]);
});

it("lists the engine-owned flags typed into launch arguments, bare or with =, and nothing else", () => {
  expect(ignoredFlags("--resume abc --verbose --model=opus --modelx", INFO.ownedFlags)).toEqual(["--model", "--resume"]);
  expect(ignoredFlags("  --verbose --debug api ", INFO.ownedFlags)).toEqual([]);
});

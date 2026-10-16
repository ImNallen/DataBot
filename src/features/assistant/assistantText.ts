import type { ProbeOutcome, ProviderState } from "../../ipc/bindings";

/** "just now" under a minute, then whole minutes, hours, or days. */
export function timeAgo(nowMs: number, atMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - atMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The Providers heading's status: any probe running, else the newest finished one. */
export function checkedAgo(providers: readonly ProviderState[], nowMs: number): string {
  if (providers.some((p) => p.checking)) return "Checking…";
  const times = providers.flatMap((p) => (p.checkedAtMs === null ? [] : [p.checkedAtMs]));
  return times.length === 0 ? "Not checked yet" : `Checked ${timeAgo(nowMs, Math.max(...times))}`;
}

export type StatusTone = "ok" | "warn" | "error" | "muted";

/** The line under a provider's name. A finished probe stays on screen while the next one runs. */
export function providerStatus(state: ProviderState | undefined): { text: string; tone: StatusTone } {
  const outcome = state?.outcome;
  if (!outcome) return { text: state?.checking ? "Checking…" : "Not checked yet", tone: "muted" };
  switch (outcome.kind) {
    case "Ready":
      return { text: outcome.plan ? `Signed in · ${outcome.plan}` : "Signed in", tone: "ok" };
    case "SignedOut":
      return { text: "Not signed in", tone: "warn" };
    case "NotFound":
      return { text: "Not found", tone: "error" };
    case "Broken":
      return { text: outcome.message, tone: "error" };
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

export function outcomeVersion(outcome: ProbeOutcome | null | undefined): string | null {
  if (!outcome || outcome.kind === "NotFound") return null;
  return outcome.version;
}

/** The engine-owned flags in typed launch arguments, as `--model` or `--model=opus`, in the order the engine lists them. */
export function ignoredFlags(launchArgs: string, ownedFlags: readonly string[]): string[] {
  const words = launchArgs.split(/\s+/).filter(Boolean);
  return ownedFlags.filter((flag) => words.some((w) => w === flag || w.startsWith(`${flag}=`)));
}

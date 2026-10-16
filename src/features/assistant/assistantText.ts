import type { AgentError, ProbeOutcome, ProviderConfig, ProviderState } from "../../ipc/bindings";
import type { UserEntry } from "../../state/transcript";
import { pluralRows } from "../results/format";

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

/** How the transcript names a provider: its display name and the command that signs it in. */
export type ProviderVoice = { name: string; signInCommand: string };

/** A failed turn's line, and whether its fix lives in Settings → Providers or in sending the turn again. */
export function agentErrorText(e: AgentError, p: ProviderVoice): { text: string; action: "settings" | "retry" } {
  switch (e.kind) {
    case "NotFound":
      return { text: `${p.name} CLI not found at ${e.binary}.`, action: "settings" };
    case "SignedOut":
      return { text: `${p.name} is signed out. Run ${p.signInCommand} in a terminal.`, action: "settings" };
    case "Exited": {
      const code = e.code === null ? "" : ` (code ${e.code})`;
      const detail = e.detail.trim();
      return { text: detail ? `${p.name} exited${code}: ${detail}` : `${p.name} exited${code}.`, action: "retry" };
    }
    case "Provider":
      return { text: e.message, action: "retry" };
    default: {
      const unreachable: never = e;
      return unreachable;
    }
  }
}

/** The dim line under a sent message: where it was asked from and what rode along. */
export function contextChip(user: UserEntry): string | null {
  const { context, attachment } = user;
  const parts: string[] = [];
  const db = context?.db?.database;
  const where = context?.connectionName && db ? `${context.connectionName} / ${db}` : (db ?? context?.connectionName);
  if (where) parts.push(where);
  if (context?.tabTitle) parts.push(context.tabTitle);
  if (attachment) parts.push(`${pluralRows(attachment.totalRows)} attached`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export type ProviderBanner =
  | { kind: "Off"; name: string }
  | { kind: "NotFound"; name: string; binary: string }
  | { kind: "SignedOut"; name: string; command: string }
  | { kind: "Broken"; name: string; message: string };

/** Why the chat's provider may not answer. Only Off blocks Send, since a probe can be stale. */
export function providerBanner(config: ProviderConfig | undefined, state: ProviderState | undefined): ProviderBanner | null {
  if (!config) return null;
  const name = config.displayName;
  if (!config.enabled) return { kind: "Off", name };
  if (!state?.outcome) return null;
  const outcome = state.outcome;
  switch (outcome.kind) {
    case "NotFound":
      return { kind: "NotFound", name, binary: outcome.binary };
    case "SignedOut":
      return { kind: "SignedOut", name, command: state.info.signInCommand };
    case "Broken":
      return { kind: "Broken", name, message: outcome.message };
    case "Ready":
      return null;
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

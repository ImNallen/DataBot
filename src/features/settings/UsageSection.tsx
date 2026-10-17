import { IconAlertTriangle, IconRefresh, IconRotate } from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { LimitLevel, LimitSource, LimitWindow, SourceLimits } from "../../ipc/bindings";
import { cx, IconButton } from "../../ui/primitives";
import { useNow } from "../../ui/useNow";
import { SOURCE_ICONS } from "../assistant/providerIcons";
import { refreshLimits, useLimits, useLimitsReads } from "./useLimits";
import { checkedText, formatReset } from "./usageText";

const SOURCE_BAR = { Claude: "bg-claude/35", Codex: "bg-codex/35" } satisfies Record<LimitSource, string>;

const LABEL_INSIDE_AT = 12;

const LEVEL_NOTE = {
  Normal: null,
  Low: (
    <span className="flex items-center gap-1 text-amber">
      <IconAlertTriangle size={13} />
      Running low
    </span>
  ),
  Exhausted: (
    <span className="flex items-center gap-1 text-danger">
      <IconAlertTriangle size={13} />
      Limit reached
    </span>
  ),
} satisfies Record<LimitLevel, ReactNode>;

export function UsageRefresh() {
  const { report, loading } = useLimits();
  const now = useNow(report !== null, 30_000);
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <span data-testid="usage-checked" className="text-ui-12 text-dim">
        {checkedText(report, loading, now)}
      </span>
      <IconButton data-testid="usage-refresh" aria-label="Refresh limits" title="Refresh limits" disabled={loading} onClick={refreshLimits}>
        <IconRefresh size={15} className={cx(loading && "animate-spin")} />
      </IconButton>
    </div>
  );
}

export function UsageLimitsSetting() {
  useLimitsReads();
  const { report, error } = useLimits();
  const now = useNow(report !== null, 30_000);
  return (
    <section data-setting="usageLimits" aria-label="Usage limits" className="flex flex-col gap-6">
      {error && (
        <p data-testid="usage-error" className="px-1 text-ui-12 text-danger">
          {error}
        </p>
      )}
      {report === null && !error && <LimitsSkeleton />}
      {report?.sources.map((s) => <SourceBlock key={s.source} limits={s} now={now} />)}
      <p className="px-1 text-ui-12 text-dim">Limits come from each provider's own account and reset on its schedule.</p>
    </section>
  );
}

function SourceBlock({ limits, now }: { limits: SourceLimits; now: number }) {
  const { source, name, outcome } = limits;
  const Mark = SOURCE_ICONS[source];
  const plan = outcome.kind === "Ready" || outcome.kind === "NoLimits" ? outcome.plan : null;
  return (
    <section data-testid={`usage-source-${source}`} aria-label={name} className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 px-1 text-ui-13">
        <Mark size={15} />
        <span className="font-medium text-fg">{name}</span>
        {plan && <span className="text-dim">· {plan}</span>}
        {outcome.kind === "NotFound" && (
          <span data-testid={`usage-missing-${source}`} title={outcome.binary} className="text-dim">
            · not installed
          </span>
        )}
      </h2>
      <SourceBody limits={limits} now={now} />
    </section>
  );
}

function SourceBody({ limits, now }: { limits: SourceLimits; now: number }) {
  const { source, outcome } = limits;
  switch (outcome.kind) {
    case "Ready":
      return outcome.windows.length === 0 ? (
        <Note testId={`usage-note-${source}`}>The account reported no limits.</Note>
      ) : (
        outcome.windows.map((w) => <LimitCard key={w.id} source={source} window={w} now={now} />)
      );
    case "NoLimits":
      return <Note testId={`usage-note-${source}`}>No subscription limits on this sign-in.</Note>;
    case "SignedOut":
      return (
        <Note testId={`usage-note-${source}`}>
          Signed out. Run <code className="rounded bg-hover px-1 font-mono text-ui-12 text-fg">{outcome.signInCommand}</code> in a terminal.
        </Note>
      );
    case "NotFound":
      return null;
    case "Failed":
      return (
        <div data-testid={`usage-failed-${source}`} className="flex items-center gap-3 rounded-xl border border-control px-4 py-3.5 text-ui-12">
          <span className="min-w-0 flex-1 text-danger selectable">{outcome.message}</span>
          <button type="button" onClick={refreshLimits} className="shrink-0 text-fg underline underline-offset-2 hover:text-fg/80">
            Try again
          </button>
        </div>
      );
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

function Note({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <p data-testid={testId} className="rounded-xl border border-control px-4 py-3.5 text-ui-12 text-dim">
      {children}
    </p>
  );
}

function LimitCard({ source, window: w, now }: { source: LimitSource; window: LimitWindow; now: number }) {
  return (
    <div data-testid={`limit-${source}-${w.id}`} className="flex items-center gap-6 rounded-xl border border-control px-4 py-3.5">
      <div className="w-[150px] shrink-0">
        <div className="text-ui-13 text-muted">{w.label}</div>
        <div className="flex items-baseline gap-1.5">
          <span className={cx("text-ui-26 leading-tight font-medium tabular-nums", w.level === "Exhausted" ? "text-danger" : "text-fg")}>{w.leftPercent}%</span>
          <span className="text-ui-12 text-dim">left</span>
        </div>
        {LEVEL_NOTE[w.level] && <div className="mt-0.5 text-ui-12">{LEVEL_NOTE[w.level]}</div>}
      </div>
      <LimitBar source={source} left={w.leftPercent} reset={formatReset(w.resetsAtMs, now)} label={w.label} />
    </div>
  );
}

function LimitBar({ source, left, reset, label }: { source: LimitSource; left: number; reset: string | null; label: string }) {
  return (
    <div
      role="meter"
      aria-label={`${label} left`}
      aria-valuenow={left}
      aria-valuemin={0}
      aria-valuemax={100}
      className="limit-stripes relative h-7 min-w-0 flex-1 overflow-hidden rounded-md bg-hover"
    >
      <div className={cx("limit-stripes absolute inset-y-0 left-0 rounded-md", SOURCE_BAR[source])} style={{ width: `${left}%` }} />
      <span
        className="absolute top-1/2 -translate-y-1/2 text-ui-12 font-medium text-fg tabular-nums"
        style={{ left: left >= LABEL_INSIDE_AT ? "10px" : `calc(${left}% + 8px)` }}
      >
        {left}%
      </span>
      {reset && (
        <span className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-1 rounded bg-bg/80 px-1.5 py-0.5 text-ui-12 text-muted tabular-nums">
          <IconRotate size={12} />
          {reset}
        </span>
      )}
    </div>
  );
}

function LimitsSkeleton() {
  return (
    <div data-testid="usage-loading" className="flex flex-col gap-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-[86px] animate-pulse rounded-xl border border-control bg-hover/50" />
      ))}
    </div>
  );
}

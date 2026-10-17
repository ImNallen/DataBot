import { useEffect } from "react";
import { create } from "zustand";
import { commands, type LimitsReport } from "../../ipc/bindings";
import { nextReset } from "./usageText";

type LimitsData = { report: LimitsReport | null; loading: boolean; error: string | null };

export const useLimits = create<LimitsData>()(() => ({ report: null, loading: false, error: null }));

export function refreshLimits() {
  if (useLimits.getState().loading) return;
  useLimits.setState({ loading: true, error: null });
  commands.usageLimits().then(
    (report) => useLimits.setState({ report, loading: false }),
    (e: unknown) => useLimits.setState({ loading: false, error: String(e) }),
  );
}

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export function useLimitsReads() {
  const report = useLimits((s) => s.report);
  useEffect(() => refreshLimits(), []);
  const reset = report && nextReset(report);
  useEffect(() => {
    if (reset === null) return;
    const t = setTimeout(refreshLimits, Math.min(Math.max(0, reset - Date.now()) + 1000, MAX_TIMEOUT_MS));
    return () => clearTimeout(t);
  }, [reset]);
}

import { X } from "lucide-react";
import type { RightPanel as Panel } from "../ipc/bindings";
import { HistoryPanel } from "../features/history/HistoryPanel";
import { SchemaPanel } from "../features/schema/SchemaPanel";
import { useWorkspace } from "../state/workspace";
import { cx, IconButton } from "../ui/primitives";

const TABS = [
  { panel: "Schema", label: "Schema" },
  { panel: "History", label: "History" },
] as const satisfies readonly { panel: Panel; label: string }[];

export function RightPanel({ panel }: { panel: Panel }) {
  const setLayout = useWorkspace((s) => s.setLayout);
  return (
    <aside data-testid="right-panel" className="flex w-[341px] shrink-0 flex-col border-l border-border bg-bg">
      <div className="flex h-[52px] shrink-0 items-center gap-1 border-b border-border pr-3 pl-3">
        {TABS.map((t) => (
          <button
            key={t.panel}
            type="button"
            data-testid={`right-tab-${t.panel}`}
            onClick={() => setLayout({ rightPanel: t.panel })}
            className={cx("h-8 rounded-lg px-3 text-[14px]", panel === t.panel ? "bg-border text-fg" : "text-dim hover:text-muted")}
          >
            {t.label}
          </button>
        ))}
        <div className="flex-1" />
        <IconButton aria-label="Close panel" onClick={() => setLayout({ rightPanel: null })}>
          <X size={16} />
        </IconButton>
      </div>
      {panel === "History" ? <HistoryPanel /> : <SchemaPanel />}
    </aside>
  );
}

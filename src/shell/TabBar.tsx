import { Plus, Table2, X } from "lucide-react";
import { useState } from "react";
import { closeTab, openSqlTab } from "../features/editor/runActions";
import type { TabId } from "../ipc/bindings";
import { useLive } from "../state/live";
import { hasUncommittedWork } from "../state/status";
import { tabLabel, useWorkspace } from "../state/workspace";
import { cx } from "../ui/primitives";

function TabItem({ id }: { id: TabId }) {
  const tab = useWorkspace((s) => s.tabs[id]);
  const active = useWorkspace((s) => s.active === id);
  const setActive = useWorkspace((s) => s.setActive);
  const renameTab = useWorkspace((s) => s.renameTab);
  const dirty = useLive((s) => hasUncommittedWork(s.consoles[id]));
  const [editing, setEditing] = useState(false);
  if (!tab) return null;

  return (
    <div
      data-testid={`tab-${id}`}
      data-active={active}
      role="tab"
      aria-selected={active}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          void closeTab(id);
        } else setActive(id);
      }}
      onDoubleClick={() => tab.kind === "sql" && setEditing(true)}
      className={cx(
        "group relative flex h-full max-w-[240px] min-w-0 shrink-0 cursor-default items-center gap-2 border-r border-border pr-2 pl-3.5",
        active ? "bg-raised text-fg" : "text-dim hover:text-muted",
      )}
    >
      {tab.kind === "sql" ? (
        <span className="font-mono text-[9.5px] font-bold tracking-tight text-badge">SQL</span>
      ) : (
        <Table2 size={14} className="shrink-0 text-muted" />
      )}
      {editing ? (
        <input
          autoFocus
          defaultValue={tab.kind === "sql" ? tab.title : ""}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            const title = e.currentTarget.value.trim();
            if (title) renameTab(id, title);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setEditing(false);
          }}
          className="w-36 bg-transparent text-[13.5px] text-fg outline-none"
        />
      ) : (
        <span className="truncate text-[13.5px]">{tabLabel(tab)}</span>
      )}
      <span className="relative grid size-5 shrink-0 place-items-center">
        {dirty && (
          <span data-testid={`tab-dirty-${id}`} className="absolute size-1.5 rounded-full bg-dim group-hover:hidden" />
        )}
        <button
          type="button"
          aria-label="Close tab"
          data-testid={`tab-close-${id}`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => void closeTab(id)}
          className={cx(
            "grid size-5 place-items-center rounded text-dim hover:bg-hover hover:text-fg",
            active && !dirty ? "visible" : "invisible group-hover:visible",
          )}
        >
          <X size={13} />
        </button>
      </span>
    </div>
  );
}

export function TabBar() {
  const order = useWorkspace((s) => s.order);
  return (
    <div role="tablist" className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border [scrollbar-width:none]">
      {order.map((id) => (
        <TabItem key={id} id={id} />
      ))}
      <button
        type="button"
        data-testid="new-tab"
        aria-label="New SQL tab"
        onClick={() => openSqlTab()}
        className="grid w-10 shrink-0 place-items-center text-muted hover:text-fg"
      >
        <Plus size={16} />
      </button>
    </div>
  );
}

import { IconTable, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { closeTab } from "../features/editor/runActions";
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
        "group relative flex h-7 max-w-[240px] min-w-0 shrink-0 cursor-default items-center gap-2 rounded-md pr-1 pl-2.5",
        active ? "bg-pill text-fg" : "text-dim hover:bg-hover hover:text-muted",
      )}
    >
      {tab.kind === "sql" ? (
        <span className="font-mono text-ui-9.5 font-bold tracking-tight text-badge">SQL</span>
      ) : (
        <IconTable size={14} className="shrink-0 text-muted" />
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
          className="w-36 bg-transparent text-ui-13.5 text-fg outline-none"
        />
      ) : (
        <span className="truncate text-ui-13.5">{tabLabel(tab)}</span>
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
          <IconX size={13} />
        </button>
      </span>
    </div>
  );
}

export function TabBar() {
  const order = useWorkspace((s) => s.order);
  return (
    <div role="tablist" className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto px-2 [scrollbar-width:none]">
      {order.map((id) => (
        <TabItem key={id} id={id} />
      ))}
    </div>
  );
}

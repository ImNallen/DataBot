import * as Menu from "@radix-ui/react-dropdown-menu";
import { IconChevronDown, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { ColumnFilter, FilterOp, TableQuery } from "../../ipc/bindings";
import { isFiltered, type TableTab } from "../../state/workspace";
import { cx, IconButton, MenuContent, MenuItem } from "../../ui/primitives";
import { updateTableQuery } from "../editor/runActions";
import { FILTER_OPS, takesValue, useFilterDrafts, type FilterDraft } from "./tableQuery";

const NO_DRAFTS: FilterDraft[] = [];
const CHIP = "flex h-[26px] shrink-0 items-center gap-1 rounded-md border border-control bg-raised pr-0.5 pl-2 text-[12.5px]";

function FilterChip({
  filter,
  autoFocus,
  onCommit,
  onRemove,
}: {
  filter: ColumnFilter;
  autoFocus?: boolean;
  onCommit: (f: ColumnFilter) => void;
  onRemove: () => void;
}) {
  const [op, setOp] = useState<FilterOp>(filter.op);
  const [value, setValue] = useState(filter.value);
  useEffect(() => {
    setOp(filter.op);
    setValue(filter.value);
  }, [filter.op, filter.value]);

  const commit = (next: { op: FilterOp; value: string }) => {
    if (takesValue(next.op) && next.value === "") return;
    if (next.op === filter.op && next.value === filter.value) return;
    onCommit({ column: filter.column, ...next });
  };

  return (
    <div data-testid={`filter-chip-${filter.column}`} className={CHIP}>
      <span className="font-medium text-fg">{filter.column}</span>
      <Menu.Root modal={false}>
        <Menu.Trigger
          data-testid={`filter-op-${filter.column}`}
          className="inline-flex h-5 items-center gap-0.5 rounded px-1 text-keyword outline-none hover:bg-hover data-[state=open]:bg-hover"
        >
          {FILTER_OPS.find((o) => o.op === op)?.label}
          <IconChevronDown size={11} className="text-dim" />
        </Menu.Trigger>
        <MenuContent>
          {FILTER_OPS.map((o) => (
            <MenuItem
              key={o.op}
              checked={o.op === op}
              onSelect={() => {
                setOp(o.op);
                commit({ op: o.op, value });
              }}
            >
              {o.label}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu.Root>
      {takesValue(op) && (
        <input
          data-testid={`filter-value-${filter.column}`}
          autoFocus={autoFocus}
          value={value}
          placeholder="value"
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit({ op, value });
            if (e.key === "Escape") setValue(filter.value);
          }}
          style={{ width: `${Math.max(5, Math.min(24, value.length + 1))}ch` }}
          className="h-5 min-w-0 rounded bg-bg px-1 font-mono text-[12px] text-fg outline-none placeholder:text-faint focus:ring-1 focus:ring-accent-border"
        />
      )}
      <IconButton aria-label={`Remove ${filter.column} filter`} className="size-5" onClick={onRemove}>
        <IconX size={12} />
      </IconButton>
    </div>
  );
}

function ClauseInput({
  label,
  testId,
  applied,
  placeholder,
  onApply,
  className,
}: {
  label: string;
  testId: string;
  applied: string;
  placeholder: string;
  onApply: (text: string) => void;
  className?: string;
}) {
  const [text, setText] = useState(applied);
  useEffect(() => setText(applied), [applied]);
  const dirty = text.trim() !== applied.trim();
  return (
    <label className={cx("flex h-[26px] min-w-0 items-center gap-1.5 rounded-md px-1.5 focus-within:bg-bg focus-within:ring-1 focus-within:ring-accent-border", className)}>
      <span className="shrink-0 font-mono text-[11.5px] font-medium text-keyword">{label}</span>
      <input
        data-testid={testId}
        value={text}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && dirty) onApply(text);
          if (e.key === "Escape") setText(applied);
        }}
        className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-fg outline-none placeholder:text-faint"
      />
      {dirty && <span className="shrink-0 text-[11px] text-dim">↵</span>}
    </label>
  );
}

export function FilterBar({ tab }: { tab: TableTab }) {
  const { query } = tab;
  const drafts = useFilterDrafts((s) => s.drafts[tab.id] ?? NO_DRAFTS);
  const removeDraft = useFilterDrafts((s) => s.remove);
  const update = (f: (q: TableQuery) => TableQuery) => updateTableQuery(tab.id, f);
  const active = isFiltered(query) || query.orderBy.trim() !== "";

  return (
    <div data-testid="filter-bar" className="flex h-[38px] shrink-0 items-center gap-1.5 overflow-x-auto border-b border-grid px-1.5">
      <ClauseInput
        label="WHERE"
        testId="filter-where"
        applied={query.where}
        placeholder="region = 'EU-West'"
        onApply={(where) => update((q) => ({ ...q, where }))}
        className="min-w-[200px] flex-[3]"
      />

      {query.filters.map((f, i) => (
        <FilterChip
          key={`${f.column}-${i}`}
          filter={f}
          onCommit={(next) => update((q) => ({ ...q, filters: q.filters.map((x, j) => (j === i ? next : x)) }))}
          onRemove={() => update((q) => ({ ...q, filters: q.filters.filter((_, j) => j !== i) }))}
        />
      ))}
      {drafts.map((d) => (
        <FilterChip
          key={`draft-${d.id}`}
          filter={d}
          autoFocus
          onCommit={(next) => {
            removeDraft(tab.id, d.id);
            update((q) => ({ ...q, filters: [...q.filters, next] }));
          }}
          onRemove={() => removeDraft(tab.id, d.id)}
        />
      ))}

      <div className="h-4 w-px shrink-0 bg-control" />
      <ClauseInput
        label="ORDER BY"
        testId="filter-order-by"
        applied={query.orderBy}
        placeholder="created_at DESC"
        onApply={(orderBy) => update((q) => ({ ...q, orderBy }))}
        className="min-w-[160px] flex-[2]"
      />

      {active && (
        <button
          type="button"
          data-testid="filter-clear"
          onClick={() => update(() => ({ orderBy: "", filters: [], where: "" }))}
          className="h-[26px] shrink-0 rounded-md px-2 text-[12.5px] text-dim hover:bg-hover hover:text-fg"
        >
          Clear
        </button>
      )}
    </div>
  );
}

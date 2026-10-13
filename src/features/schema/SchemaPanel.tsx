import { KeyRound, Table2 } from "lucide-react";
import { findRelation, isViewKind, useCatalog } from "../../state/catalog";
import { useWorkspace, type RelationRef } from "../../state/workspace";
import { compactCount, groupDigits } from "../results/format";

function useSchemaTarget(): RelationRef | null {
  const active = useWorkspace((s) => (s.active ? s.tabs[s.active] : undefined));
  const selected = useWorkspace((s) => s.selected);
  if (active?.kind === "table") return { connectionId: active.connectionId, schema: active.schema, relation: active.table };
  return selected;
}

export function SchemaPanel() {
  const target = useSchemaTarget();
  const view = useCatalog((s) => (target ? s.views[target.connectionId] : undefined));
  const rel = target ? findRelation(view, target.schema, target.relation) : undefined;

  if (!target || !rel) {
    return (
      <div className="grid flex-1 place-items-center px-8 text-center text-[13px] leading-5 text-dim">
        Select a table in the tree, or open one, to see its columns.
      </div>
    );
  }

  return (
    <div data-testid="schema-panel" className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-b border-border px-4 py-3.5">
        <div className="flex items-center gap-2">
          <Table2 size={15} className="text-muted" />
          <span className="truncate text-[14px] font-medium text-fg">{rel.name}</span>
        </div>
        <div className="mt-1 text-[12px] text-dim">
          {isViewKind(rel.kind) ? "View" : "Table"} in {target.schema}
          {rel.rowEstimate !== null && ` · about ${compactCount(rel.rowEstimate)} rows`}
          {` · ${rel.columns.length} columns`}
        </div>
      </div>
      <ul className="py-1.5">
        {rel.columns.map((c) => (
          <li key={c.attnum} data-testid={`schema-col-${c.name}`} className="flex h-[30px] items-center gap-2 px-4 text-[13px]">
            <span className="grid w-4 shrink-0 place-items-center">
              {c.pk && <KeyRound size={13} className="text-amber" aria-label="Primary key" />}
            </span>
            <span className="min-w-0 flex-1 truncate text-fg">{c.name}</span>
            <span className="shrink-0 font-mono text-[11.5px] text-muted">{c.typeDisplay}</span>
            <span className="w-14 shrink-0 text-right text-[11.5px] text-faint">{c.notNull ? "not null" : "null"}</span>
          </li>
        ))}
      </ul>
      {rel.rowEstimate !== null && (
        <div className="px-4 pb-4 text-[11.5px] text-faint">Row estimate {groupDigits(String(rel.rowEstimate))} from the last ANALYZE.</div>
      )}
    </div>
  );
}

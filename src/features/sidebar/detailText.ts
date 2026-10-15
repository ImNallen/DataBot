import type { ColumnInfo, DefaultValue, FkAction, IndexInfo, KeyInfo, TriggerInfo, TriggerTiming } from "../../ipc/bindings";
import { shortType } from "../results/format";

/** The two texts of a detail row: beside the name on the right, and the line under it. */
export type RowText = { trailing: string; second: string };

export function columnType(c: ColumnInfo): string {
  return c.notNull ? shortType(c.typeDisplay) : `${shortType(c.typeDisplay)} · null`;
}

export function defaultText(v: DefaultValue): string {
  switch (v.kind) {
    case "Identity":
      return v.always ? "identity always" : "identity";
    case "Expr":
      return v.sql;
    case "Generated":
      return `generated ${v.sql}`;
  }
}

const list = (names: readonly string[]) => `(${names.join(", ")})`;

const FK_ACTIONS: Record<FkAction, string | null> = {
  NoAction: null,
  Restrict: "restrict",
  Cascade: "cascade",
  SetNull: "set null",
  SetDefault: "set default",
};

/** `schema` is the table's own; a key into another schema names it. */
export function keyText(k: KeyInfo, schema: string): RowText {
  switch (k.kind.kind) {
    case "Primary":
      return { trailing: "primary", second: list(k.columns) };
    case "Unique":
      return { trailing: "unique", second: list(k.columns) };
    case "Check":
      return { trailing: "check", second: k.kind.definition };
    case "Foreign": {
      const { refSchema, refTable, refColumns, onDelete, onUpdate } = k.kind;
      const target = refSchema === schema ? refTable : `${refSchema}.${refTable}`;
      const actions = [
        FK_ACTIONS[onDelete] && `on delete ${FK_ACTIONS[onDelete]}`,
        FK_ACTIONS[onUpdate] && `on update ${FK_ACTIONS[onUpdate]}`,
      ].filter(Boolean);
      const tail = actions.length ? ` · ${actions.join(", ")}` : "";
      return { trailing: "foreign", second: `${list(k.columns)} → ${target}${list(refColumns)}${tail}` };
    }
  }
}

export function indexText(i: IndexInfo): RowText {
  const traits = [i.unique && "unique", i.predicate !== null && "partial", !i.valid && "invalid"].filter(Boolean);
  return {
    trailing: traits.length ? traits.join(" ") : i.method,
    second: i.predicate === null ? i.keys : `${i.keys} WHERE ${i.predicate}`,
  };
}

const TIMING: Record<TriggerTiming, string> = { Before: "before", After: "after", InsteadOf: "instead of" };

export function triggerText(t: TriggerInfo): RowText {
  const traits = [TIMING[t.timing], !t.perRow && "statement", !t.enabled && "disabled"].filter(Boolean);
  return {
    trailing: traits.join(" · "),
    second: `${t.events.map((e) => e.toUpperCase()).join(", ")} · ${t.function}()`,
  };
}

import { describe, expect, it } from "vitest";
import type { ColumnInfo, IndexInfo, KeyInfo, TriggerInfo } from "../../ipc/bindings";
import { columnType, defaultText, indexText, keyText, triggerText } from "./detailText";

const column = (typeDisplay: string, notNull: boolean): ColumnInfo => ({
  attnum: 1,
  name: "c",
  typeDisplay,
  category: "Temporal",
  notNull,
  pk: false,
  fk: false,
});

describe("columnType", () => {
  it("shows the short type and marks a nullable column", () => {
    expect(columnType(column("timestamp with time zone", true))).toBe("timestamptz");
    expect(columnType(column("timestamp with time zone", false))).toBe("timestamptz · null");
  });
});

describe("defaultText", () => {
  it("names identity and generated columns and passes expressions through", () => {
    expect(defaultText({ kind: "Identity", always: true })).toBe("identity always");
    expect(defaultText({ kind: "Identity", always: false })).toBe("identity");
    expect(defaultText({ kind: "Expr", sql: "'pending'" })).toBe("'pending'");
    expect(defaultText({ kind: "Generated", sql: "(qty * price)" })).toBe("generated (qty * price)");
  });
});

describe("keyText", () => {
  const key = (kind: KeyInfo["kind"], columns: string[]): KeyInfo => ({ name: "k", columns, kind });

  it("lists primary and unique key columns", () => {
    expect(keyText(key({ kind: "Primary" }, ["id"]), "public")).toEqual({ trailing: "primary", second: "(id)" });
    expect(keyText(key({ kind: "Unique" }, ["number"]), "public")).toEqual({ trailing: "unique", second: "(number)" });
  });

  it("points a foreign key at its target, naming the schema only when it differs", () => {
    const fk = (refSchema: string, onDelete: "NoAction" | "Cascade") =>
      key(
        { kind: "Foreign", refSchema, refTable: "addresses", refColumns: ["customer_id", "id"], onDelete, onUpdate: "NoAction" },
        ["customer_id", "ship_address_id"],
      );
    expect(keyText(fk("public", "NoAction"), "public")).toEqual({
      trailing: "foreign",
      second: "(customer_id, ship_address_id) → addresses(customer_id, id)",
    });
    expect(keyText(fk("crm", "Cascade"), "public").second).toBe("(customer_id, ship_address_id) → crm.addresses(customer_id, id) · on delete cascade");
  });

  it("shows a check constraint's definition", () => {
    expect(keyText(key({ kind: "Check", definition: "CHECK ((qty > 0))" }, ["qty"]), "public")).toEqual({ trailing: "check", second: "CHECK ((qty > 0))" });
  });
});

describe("indexText", () => {
  const index = (over: Partial<IndexInfo>): IndexInfo => ({
    name: "i",
    method: "btree",
    unique: false,
    primary: false,
    valid: true,
    keys: "(created_at DESC)",
    predicate: null,
    ...over,
  });

  it("names the method of a plain index and the traits of the rest", () => {
    expect(indexText(index({}))).toEqual({ trailing: "btree", second: "(created_at DESC)" });
    expect(indexText(index({ unique: true, primary: true, keys: "(id)" }))).toEqual({ trailing: "unique", second: "(id)" });
    expect(indexText(index({ keys: "(status)", predicate: "status <> 'paid'::text" }))).toEqual({
      trailing: "partial",
      second: "(status) WHERE status <> 'paid'::text",
    });
    expect(indexText(index({ method: "gin", valid: false })).trailing).toBe("invalid");
  });
});

describe("triggerText", () => {
  const trigger = (over: Partial<TriggerInfo>): TriggerInfo => ({
    name: "t",
    timing: "Before",
    events: ["Update"],
    perRow: true,
    enabled: true,
    function: "set_updated_at",
    ...over,
  });

  it("shows timing on the right and events with the function below", () => {
    expect(triggerText(trigger({}))).toEqual({ trailing: "before", second: "UPDATE · set_updated_at()" });
    expect(triggerText(trigger({ timing: "After", events: ["Insert", "Update", "Delete"], function: "audit_order" }))).toEqual({
      trailing: "after",
      second: "INSERT, UPDATE, DELETE · audit_order()",
    });
    expect(triggerText(trigger({ timing: "InsteadOf", perRow: false, enabled: false })).trailing).toBe("instead of · statement · disabled");
  });
});

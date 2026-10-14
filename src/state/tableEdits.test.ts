import { expect, it } from "vitest";
import { addRow, NO_EDITS, pendingCount, removeNewRows, resetNewCell, rowKey, setCell, setNewCell, toChanges, toggleDeletes, useTableEdits, type RowId } from "./tableEdits";

const row = (...values: (string | null)[]): RowId => ({ key: rowKey(values), values });

it("turns pending edits into engine changes keyed by primary key", () => {
  let e = addRow(NO_EDITS, 7);
  e = setNewCell(e, 7, "name", "d");
  e = setNewCell(e, 7, "note", null);
  e = setCell(e, row("2"), "name", "b2", "b");
  e = toggleDeletes(e, [row("1")]);

  const { changes, rowOf } = toChanges(e, "public", "customers", ["id"]);
  expect(changes).toEqual({
    schema: "public",
    table: "customers",
    inserts: [[{ column: "name", value: "d" }, { column: "note", value: null }]],
    updates: [{ key: [{ column: "id", value: "2" }], set: [{ column: "name", value: "b2" }] }],
    deletes: [[{ column: "id", value: "1" }]],
  });
  expect(pendingCount(e)).toBe(3);
  expect(rowOf({ kind: "Insert", index: 0 })).toEqual({ insert: 7 });
  expect(rowOf({ kind: "Update", index: 0 })).toEqual({ key: rowKey(["2"]) });
  expect(rowOf({ kind: "Delete", index: 0 })).toEqual({ key: rowKey(["1"]) });
});

it("drops an update set back to the stored value, and a new cell set back to its default", () => {
  let e = setCell(NO_EDITS, row("2"), "name", "b2", "b");
  e = setCell(e, row("2"), "name", "b", "b");
  expect(e.updates).toEqual({});

  e = setNewCell(addRow(NO_EDITS, 1), 1, "name", "x");
  e = resetNewCell(e, 1, "name");
  expect(toChanges(e, "s", "t", ["id"]).changes.inserts).toEqual([[]]);
});

it("deletes win over updates to the same row, and toggling twice restores it", () => {
  let e = setCell(NO_EDITS, row("2"), "name", "b2", "b");
  e = toggleDeletes(e, [row("2")]);
  expect(toChanges(e, "s", "t", ["id"]).changes.updates).toEqual([]);
  expect(pendingCount(e)).toBe(1);

  e = toggleDeletes(e, [row("2")]);
  expect(e.deletes).toEqual({});
  expect(pendingCount(e)).toBe(1);
});

it("marks a mixed selection deleted before it unmarks anything", () => {
  const e = toggleDeletes(toggleDeletes(NO_EDITS, [row("1")]), [row("1"), row("2")]);
  expect(Object.keys(e.deletes).sort()).toEqual([rowKey(["1"]), rowKey(["2"])]);
});

it("keys composite primary keys in column order and removes new rows by id", () => {
  const e = toggleDeletes(removeNewRows(addRow(addRow(NO_EDITS, 1), 2), [1]), [row("7", "A-1")]);
  expect(e.inserts.map((r) => r.id)).toEqual([2]);
  expect(toChanges(e, "s", "t", ["order_id", "sku"]).changes.deletes).toEqual([
    [
      { column: "order_id", value: "7" },
      { column: "sku", value: "A-1" },
    ],
  ]);
});

it("holds a tab's edits still while its submit is in flight", () => {
  const store = useTableEdits.getState();
  store.edit("t", (e) => setNewCell(addRow(e, 1), 1, "name", "a"));
  expect(store.beginSubmit("t")).toBe(true);
  expect(store.beginSubmit("t")).toBe(false);

  store.edit("t", (e) => toggleDeletes(e, [row("9")]));
  expect(store.addRow("t")).toBeNull();
  expect(useTableEdits.getState().byTab["t"]).toEqual({ ...addRow(NO_EDITS, 1), inserts: [{ id: 1, values: { name: "a" } }], failedAt: null });

  store.endSubmit("t");
  store.edit("t", (e) => toggleDeletes(e, [row("9")]));
  expect(pendingCount(useTableEdits.getState().byTab["t"]!)).toBe(2);
});

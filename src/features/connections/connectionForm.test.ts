import { expect, it } from "vitest";
import type { ConnectionConfig } from "../../ipc/bindings";
import { isDirty } from "./connectionForm";

const saved: ConnectionConfig = {
  id: "c1",
  name: "shop",
  host: "db.internal",
  port: 5433,
  database: "shop",
  user: "l1data",
  sslMode: "Require",
  caCertPath: null,
  hasPassword: true,
  color: "red",
};

const savedFields = { name: "shop", host: "db.internal", port: "5433", database: "shop", user: "l1data", sslMode: "Require", color: "red" } as const;

const newFields = { name: "", host: "localhost", port: "5432", database: "postgres", user: "postgres", sslMode: "Prefer", color: null } as const;

it("reads an untouched new form as clean", () => {
  expect(isDirty(undefined, { fields: { ...newFields }, password: { kind: "clear" }, url: "" })).toBe(false);
});

it("reads a changed host as dirty", () => {
  expect(isDirty(undefined, { fields: { ...newFields, host: "db.internal" }, password: { kind: "clear" }, url: "" })).toBe(true);
});

it("reads a new form with only a URL typed as dirty", () => {
  expect(isDirty(undefined, { fields: { ...newFields }, password: { kind: "clear" }, url: "postgres://" })).toBe(true);
});

it("reads a kept saved password as clean and a cleared one as dirty", () => {
  expect(isDirty(saved, { fields: { ...savedFields }, password: { kind: "keep" }, url: "" })).toBe(false);
  expect(isDirty(saved, { fields: { ...savedFields }, password: { kind: "clear" }, url: "" })).toBe(true);
});

it("compares color against the normalized id", () => {
  expect(isDirty(saved, { fields: { ...savedFields }, password: { kind: "keep" }, url: "" })).toBe(false);
  expect(isDirty({ ...saved, color: "#ef4444" }, { fields: { ...savedFields, color: null }, password: { kind: "keep" }, url: "" })).toBe(false);
});

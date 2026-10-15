import type { ConnectionConfig, SslMode } from "../../ipc/bindings";
import { connectionColorId, type ConnectionColorId } from "./connectionColors";

export type Fields = { name: string; host: string; port: string; database: string; user: string; sslMode: SslMode; color: ConnectionColorId | null };

export type PasswordEdit = { kind: "keep" } | { kind: "set"; value: string } | { kind: "clear" };

export type FormState = { fields: Fields; password: PasswordEdit; url: string };

export function initialFields(c: ConnectionConfig | undefined): Fields {
  return {
    name: c?.name ?? "",
    host: c?.host ?? "localhost",
    port: String(c?.port ?? 5432),
    database: c?.database ?? "postgres",
    user: c?.user ?? "postgres",
    sslMode: c?.sslMode ?? "Prefer",
    color: connectionColorId(c?.color ?? null),
  };
}

export function initialPassword(c: ConnectionConfig | undefined): PasswordEdit {
  return c?.hasPassword ? { kind: "keep" } : { kind: "clear" };
}

/** Whether the form differs from what `existing` would open it with. */
export function isDirty(existing: ConnectionConfig | undefined, form: FormState): boolean {
  const start = initialFields(existing);
  const fieldChanged = (Object.keys(start) as (keyof Fields)[]).some((k) => start[k] !== form.fields[k]);
  // The initial edit is never `set`, so comparing kinds is enough.
  return fieldChanged || form.password.kind !== initialPassword(existing).kind || form.url !== "";
}

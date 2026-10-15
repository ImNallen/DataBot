import { IconAlertCircle, IconCheck } from "@tabler/icons-react";
import { useState } from "react";
import { commands, type ConnectionConfig, type ConnectionDraft, type PasswordInput, type SslMode } from "../../ipc/bindings";
import { connectErrorText } from "../../ipc/errors";
import { useWorkspace } from "../../state/workspace";
import { Button, cx, inputClass, Modal, Spinner } from "../../ui/primitives";
import { connect } from "./connectionActions";

const SSL_MODES: { value: SslMode; label: string }[] = [
  { value: "Disable", label: "Disable" },
  { value: "Prefer", label: "Prefer" },
  { value: "Require", label: "Require" },
  { value: "VerifyCa", label: "Verify CA" },
  { value: "VerifyFull", label: "Verify full" },
];

type Fields = { name: string; host: string; port: string; database: string; user: string; sslMode: SslMode };

type PasswordEdit = { kind: "keep" } | { kind: "set"; value: string } | { kind: "clear" };

function toPasswordInput(edit: PasswordEdit): PasswordInput {
  switch (edit.kind) {
    case "keep":
      return "Keep";
    case "clear":
      return "Clear";
    case "set":
      return { Set: edit.value };
    default: {
      const unreachable: never = edit;
      return unreachable;
    }
  }
}

type Probe = { kind: "idle" } | { kind: "testing" } | { kind: "ok"; version: string } | { kind: "error"; message: string };

function initialFields(c: ConnectionConfig | undefined): Fields {
  return {
    name: c?.name ?? "",
    host: c?.host ?? "localhost",
    port: String(c?.port ?? 5432),
    database: c?.database ?? "postgres",
    user: c?.user ?? "postgres",
    sslMode: c?.sslMode ?? "Prefer",
  };
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1 block text-ui-12 text-dim">{label}</span>
      {children}
    </label>
  );
}

function ConnectionForm({ existing, onDone }: { existing: ConnectionConfig | undefined; onDone: () => void }) {
  const upsertConfig = useWorkspace((s) => s.upsertConfig);
  const [fields, setFields] = useState(() => initialFields(existing));
  const [password, setPassword] = useState<PasswordEdit>(existing?.hasPassword ? { kind: "keep" } : { kind: "clear" });
  const [probe, setProbe] = useState<Probe>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const set = (key: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFields({ ...fields, [key]: e.target.value });
    setProbe({ kind: "idle" });
  };
  const port = Number(fields.port);
  const valid = fields.name.trim() !== "" && fields.host.trim() !== "" && Number.isInteger(port) && port > 0 && port < 65_536;

  const draft = (): ConnectionDraft => ({
    id: existing?.id ?? null,
    name: fields.name.trim(),
    host: fields.host.trim(),
    port,
    database: fields.database.trim(),
    user: fields.user.trim(),
    sslMode: fields.sslMode,
    caCertPath: existing?.caCertPath ?? null,
    password: toPasswordInput(password),
    color: existing?.color ?? null,
  });

  const test = async () => {
    setProbe({ kind: "testing" });
    const res = await commands.connectionTest(draft());
    setProbe(res.status === "ok" ? { kind: "ok", version: res.data.version } : { kind: "error", message: connectErrorText(res.error) });
  };

  const submit = async () => {
    setSaving(true);
    setSaveError(null);
    const res = await commands.connectionSave(draft());
    setSaving(false);
    if (res.status === "error") {
      setSaveError(res.error.message);
      return;
    }
    upsertConfig(res.data);
    onDone();
    if (!existing) void connect(res.data.id);
  };

  const passwordPlaceholder = password.kind === "keep" ? "Saved password" : password.kind === "clear" && existing?.hasPassword ? "Password will be removed" : "";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void submit();
      }}
      className="space-y-3"
    >
      <Field label="Name">
        <input data-testid="conn-name" autoFocus className={inputClass} value={fields.name} onChange={set("name")} placeholder="prod-postgres" />
      </Field>
      <div className="flex gap-3">
        <Field label="Host" className="flex-1">
          <input data-testid="conn-host" className={inputClass} value={fields.host} onChange={set("host")} />
        </Field>
        <Field label="Port" className="w-24">
          <input data-testid="conn-port" className={inputClass} value={fields.port} onChange={set("port")} inputMode="numeric" />
        </Field>
      </div>
      <div className="flex gap-3">
        <Field label="Database" className="flex-1">
          <input data-testid="conn-database" className={inputClass} value={fields.database} onChange={set("database")} />
        </Field>
        <Field label="User" className="flex-1">
          <input data-testid="conn-user" className={inputClass} value={fields.user} onChange={set("user")} />
        </Field>
      </div>
      <div className="flex gap-3">
        <Field label="Password" className="flex-1">
          <input
            data-testid="conn-password"
            type="password"
            className={inputClass}
            value={password.kind === "set" ? password.value : ""}
            placeholder={passwordPlaceholder}
            onChange={(e) => {
              const value = e.target.value;
              setProbe({ kind: "idle" });
              setPassword(value ? { kind: "set", value } : existing?.hasPassword ? { kind: "keep" } : { kind: "clear" });
            }}
          />
          {existing?.hasPassword && (
            <button
              type="button"
              data-testid="conn-password-clear"
              onClick={() => setPassword(password.kind === "clear" ? { kind: "keep" } : { kind: "clear" })}
              className="mt-1 text-ui-11.5 text-dim hover:text-fg"
            >
              {password.kind === "clear" ? "Keep the saved password" : "Remove the saved password"}
            </button>
          )}
        </Field>
        <Field label="SSL mode" className="w-36">
          <select data-testid="conn-ssl" className={cx(inputClass, "appearance-none")} value={fields.sslMode} onChange={set("sslMode")}>
            {SSL_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div data-testid="conn-test-result" data-state={probe.kind} className="min-h-5 text-ui-12.5">
        {probe.kind === "testing" && (
          <span className="flex items-center gap-2 text-dim">
            <Spinner /> Connecting
          </span>
        )}
        {probe.kind === "ok" && (
          <span className="flex items-center gap-1.5 text-fg">
            <IconCheck size={14} className="text-green" /> Connected to PostgreSQL {probe.version}
          </span>
        )}
        {probe.kind === "error" && (
          <span className="flex items-start gap-1.5 text-danger">
            <IconAlertCircle size={14} className="mt-0.5 shrink-0" /> {probe.message}
          </span>
        )}
        {saveError && <span className="text-danger">{saveError}</span>}
      </div>

      <div className="flex items-center justify-between pt-1">
        <Button data-testid="conn-test" disabled={!valid || probe.kind === "testing"} onClick={() => void test()}>
          Test connection
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button data-testid="conn-save" type="submit" variant="primary" disabled={!valid || saving}>
            {existing ? "Save" : "Save and connect"}
          </Button>
        </div>
      </div>
    </form>
  );
}

export function ConnectionDialog() {
  const overlay = useWorkspace((s) => s.overlay);
  const configs = useWorkspace((s) => s.configs);
  const close = useWorkspace((s) => s.close);
  const editing = overlay.kind === "connection" ? overlay.editing : null;
  const existing = editing ? configs[editing] : undefined;
  return (
    <Modal
      open={overlay.kind === "connection"}
      onOpenChange={(o) => !o && close()}
      title={existing ? `Edit ${existing.name}` : "New PostgreSQL connection"}
      width={480}
      testId="connection-dialog"
    >
      <ConnectionForm key={editing ?? "new"} existing={existing} onDone={close} />
    </Modal>
  );
}

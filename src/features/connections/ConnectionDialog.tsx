import * as Dialog from "@radix-ui/react-dialog";
import { IconAlertCircle, IconCheck, IconEye, IconEyeOff, IconLock, IconPlus, IconSelector, IconX } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { commands, type ConnectionConfig, type ConnectionDraft, type ConnectionId, type PasswordInput, type SslMode } from "../../ipc/bindings";
import { connectErrorText } from "../../ipc/errors";
import { useLive } from "../../state/live";
import { connectionTone } from "../../state/status";
import { useWorkspace } from "../../state/workspace";
import { Button, cx, DialogBackdrop, IconButton, inputClass, Modal, PgBadge, Spinner, StatusDot } from "../../ui/primitives";
import { connect } from "./connectionActions";
import { CONNECTION_COLORS, ConnectionColorDot, connectionColorId, type ConnectionColorId } from "./connectionColors";
import { initialFields, initialPassword, isDirty, type Fields, type PasswordEdit } from "./connectionForm";

/** Each hint says what the engine's `tls()` does for the mode. */
const SSL_MODES: { value: SslMode; label: string; hint: string }[] = [
  { value: "Disable", label: "Disable", hint: "Never uses TLS." },
  { value: "Prefer", label: "Prefer", hint: "Uses TLS when the server offers it, without checking its certificate." },
  { value: "Require", label: "Require", hint: "Always uses TLS, without checking its certificate." },
  { value: "VerifyCa", label: "Verify CA", hint: "Always uses TLS and checks the certificate chain, but not the host name." },
  { value: "VerifyFull", label: "Verify full", hint: "Always uses TLS and checks the certificate chain and the host name." },
];

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

function serverText(c: { host: string; port: number; database: string }): string {
  return `${c.host}:${c.port}/${c.database}`;
}

function ListRow({
  testId,
  selected,
  mark,
  name,
  detail,
  trailing,
  onClick,
}: {
  testId: string;
  selected: boolean;
  mark: ReactNode;
  name: ReactNode;
  detail: string;
  trailing?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-current={selected || undefined}
      onClick={onClick}
      className={cx("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left", selected ? "bg-selected" : "hover:bg-hover")}
    >
      <span className="grid w-2.5 shrink-0 place-items-center">{mark}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui-13 text-fg">{name}</span>
        <span title={detail} className="block truncate font-mono text-ui-11 text-dim">
          {detail}
        </span>
      </span>
      {trailing}
    </button>
  );
}

function HollowMark({ dashed }: { dashed?: boolean }) {
  return <span className={cx("size-2 rounded-full border border-faint", dashed && "border-dashed")} />;
}

function ConnectionList({ selected, onSelect }: { selected: ConnectionId | null; onSelect: (id: ConnectionId | null) => void }) {
  const configs = useWorkspace((s) => s.configs);
  const connections = useLive((s) => s.connections);
  const list = Object.values(configs).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <aside className="flex w-[210px] shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex h-12 shrink-0 items-center justify-between pr-2 pl-4">
        <span className="text-ui-13.5 font-semibold text-fg">Connections</span>
        <Button data-testid="conn-new" variant="ghost" className="h-7 gap-1 px-2" onClick={() => onSelect(null)}>
          <IconPlus size={14} /> New
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {selected === null && (
          <ListRow testId="conn-list-new" selected mark={<HollowMark dashed />} name={<span className="italic">New connection</span>} detail="Not saved yet" />
        )}
        {list.map((c) => {
          const tone = connectionTone(connections[c.id]);
          return (
            <ListRow
              key={c.id}
              testId={`conn-list-${c.name}`}
              selected={c.id === selected}
              mark={connectionColorId(c.color) ? <ConnectionColorDot color={c.color} /> : <HollowMark />}
              name={c.name}
              detail={serverText(c)}
              trailing={tone !== "off" && <StatusDot tone={tone} />}
              onClick={() => onSelect(c.id)}
            />
          );
        })}
      </div>
      <div className="flex shrink-0 gap-2 border-t border-border px-4 py-3 text-ui-11.5 leading-4 text-dim">
        <IconLock size={14} className="mt-px shrink-0" />
        <span>Passwords are encrypted with a key kept in the system keychain.</span>
      </div>
    </aside>
  );
}

function FormRow({ label, htmlFor, labelId, hint, children }: { label: string; htmlFor?: string; labelId?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-4 border-b border-border py-3.5 last:border-b-0">
      <label id={labelId} htmlFor={htmlFor} className="pt-1.5 text-ui-13 text-muted">
        {label}
      </label>
      <div>
        {children}
        {hint && <div className="mt-1.5 text-ui-12 text-dim">{hint}</div>}
      </div>
    </div>
  );
}

type ColorChoice = ConnectionColorId | null;
const COLOR_CHOICES: readonly ColorChoice[] = [null, ...CONNECTION_COLORS.map((c) => c.id)];

function ColorPicker({ value, onChange, labelledBy }: { value: ColorChoice; onChange: (c: ColorChoice) => void; labelledBy: string }) {
  const group = useRef<HTMLDivElement>(null);
  const step = (delta: number) => {
    const next = COLOR_CHOICES[(COLOR_CHOICES.indexOf(value) + delta + COLOR_CHOICES.length) % COLOR_CHOICES.length] ?? null;
    onChange(next);
    group.current?.querySelector<HTMLElement>(`[data-testid="conn-color-${next ?? "none"}"]`)?.focus();
  };
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-labelledby={labelledBy}
      className="flex h-8 items-center gap-1.5"
      onKeyDown={(e) => {
        const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (delta === undefined) return;
        e.preventDefault();
        step(delta);
      }}
    >
      {COLOR_CHOICES.map((id) => {
        const color = CONNECTION_COLORS.find((c) => c.id === id);
        const checked = id === value;
        return (
          <button
            key={id ?? "none"}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={color?.label ?? "No color"}
            tabIndex={checked ? 0 : -1}
            data-testid={`conn-color-${id ?? "none"}`}
            onClick={() => onChange(id)}
            className={cx(
              "grid size-6 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent-border",
              checked && "ring-2 ring-run ring-offset-2 ring-offset-raised",
            )}
          >
            {color ? (
              <span className="size-4 rounded-full" style={{ backgroundColor: color.hex }} />
            ) : (
              <span className="size-4 rounded-full border border-dashed border-dim" />
            )}
          </button>
        );
      })}
    </div>
  );
}

function ConnectionForm({
  existing,
  onSaved,
  onClose,
  onDirtyChange,
}: {
  existing: ConnectionConfig | undefined;
  onSaved: () => void;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const upsertConfig = useWorkspace((s) => s.upsertConfig);
  const ids = useId();
  const [fields, setFields] = useState(() => initialFields(existing));
  const [password, setPassword] = useState<PasswordEdit>(() => initialPassword(existing));
  const [reveal, setReveal] = useState(false);
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [urlBlurred, setUrlBlurred] = useState(false);
  const urlRequest = useRef(0);
  const [probe, setProbe] = useState<Probe>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const dirty = isDirty(existing, { fields, password, url });
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  const update = (patch: Partial<Fields>) => {
    setFields((f) => ({ ...f, ...patch }));
    setProbe({ kind: "idle" });
  };
  const set = (key: "name" | "host" | "port" | "database" | "user") => (e: React.ChangeEvent<HTMLInputElement>) => update({ [key]: e.target.value });

  const parseUrl = async (text: string) => {
    const request = ++urlRequest.current;
    if (text.trim() === "") {
      setUrlError(null);
      return;
    }
    const res = await commands.connectionParseUrl(text);
    if (request !== urlRequest.current) return;
    if (res.status === "error") {
      setUrlError(res.error);
      return;
    }
    const d = res.data;
    setUrlError(null);
    update({ host: d.host, port: String(d.port), database: d.database, user: d.user, sslMode: d.sslMode });
    setPassword(typeof d.password === "object" ? { kind: "set", value: d.password.Set } : initialPassword(existing));
  };
  // A half-typed URL fails to parse, so its error waits for a blur or until it reads like a URL or a key=value string.
  const shownUrlError = urlError !== null && (urlBlurred || url.includes("://") || url.includes("=")) ? urlError : null;

  const port = Number(fields.port);
  const valid = fields.host.trim() !== "" && Number.isInteger(port) && port > 0 && port < 65_536;
  const fallbackName = `${fields.host.trim()} / ${fields.database.trim()}`;

  const draft = (): ConnectionDraft => ({
    id: existing?.id ?? null,
    name: fields.name.trim() || fallbackName,
    host: fields.host.trim(),
    port,
    database: fields.database.trim(),
    user: fields.user.trim(),
    sslMode: fields.sslMode,
    caCertPath: existing?.caCertPath ?? null,
    password: toPasswordInput(password),
    color: fields.color,
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
    onSaved();
    if (!existing) void connect(res.data.id);
  };

  const passwordPlaceholder = password.kind === "keep" ? "Saved password" : password.kind === "clear" && existing?.hasPassword ? "Password will be removed" : "password";
  const sslHint = SSL_MODES.find((m) => m.value === fields.sslMode)?.hint;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void submit();
      }}
      className="flex min-w-0 flex-1 flex-col"
    >
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border pr-3 pl-5">
        <PgBadge />
        <Dialog.Title className="min-w-0 flex-1 truncate text-ui-14 font-semibold text-fg">{existing ? existing.name : "New connection"}</Dialog.Title>
        <Dialog.Description className="sr-only">Saved connections, and the settings of the selected one.</Dialog.Description>
        <Dialog.Close asChild>
          <IconButton aria-label="Close">
            <IconX size={15} />
          </IconButton>
        </Dialog.Close>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-1">
        {!existing && (
          <FormRow
            label="URL"
            htmlFor={`${ids}-url`}
            hint={shownUrlError ? <span className="text-danger">{shownUrlError}</span> : "Optional. Paste one to fill in the fields below."}
          >
            <input
              id={`${ids}-url`}
              data-testid="conn-url"
              autoFocus
              spellCheck={false}
              className={cx(inputClass, "font-mono")}
              value={url}
              placeholder="postgres://user@host:5432/database"
              onChange={(e) => {
                setUrl(e.target.value);
                void parseUrl(e.target.value);
              }}
              onBlur={() => setUrlBlurred(true)}
            />
          </FormRow>
        )}
        <FormRow label="Server" htmlFor={`${ids}-host`}>
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <input id={`${ids}-host`} data-testid="conn-host" className={inputClass} value={fields.host} onChange={set("host")} />
            </div>
            <div className="w-24 shrink-0">
              <input data-testid="conn-port" aria-label="Port" className={inputClass} value={fields.port} onChange={set("port")} inputMode="numeric" />
            </div>
          </div>
        </FormRow>
        <FormRow label="Database" htmlFor={`${ids}-database`} hint="Opens first in the tree. You can show the server's other databases later.">
          <input id={`${ids}-database`} data-testid="conn-database" className={inputClass} value={fields.database} onChange={set("database")} />
        </FormRow>
        <FormRow
          label="Sign in"
          htmlFor={`${ids}-user`}
          hint={
            existing?.hasPassword && (
              <button
                type="button"
                data-testid="conn-password-clear"
                onClick={() => setPassword(password.kind === "clear" ? { kind: "keep" } : { kind: "clear" })}
                className="hover:text-fg"
              >
                {password.kind === "clear" ? "Keep the saved password" : "Remove the saved password"}
              </button>
            )
          }
        >
          <div className="flex gap-2">
            <input id={`${ids}-user`} data-testid="conn-user" className={inputClass} value={fields.user} onChange={set("user")} placeholder="user" />
            <div className="relative w-full">
              <input
                data-testid="conn-password"
                aria-label="Password"
                type={reveal ? "text" : "password"}
                className={cx(inputClass, "pr-8")}
                value={password.kind === "set" ? password.value : ""}
                placeholder={passwordPlaceholder}
                onChange={(e) => {
                  const value = e.target.value;
                  setProbe({ kind: "idle" });
                  setPassword(value ? { kind: "set", value } : initialPassword(existing));
                }}
              />
              <button
                type="button"
                data-testid="conn-password-reveal"
                aria-label={reveal ? "Hide password" : "Show password"}
                aria-pressed={reveal}
                onClick={() => setReveal(!reveal)}
                className="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded-md text-dim hover:bg-hover hover:text-fg"
              >
                {reveal ? <IconEyeOff size={14} /> : <IconEye size={14} />}
              </button>
            </div>
          </div>
        </FormRow>
        <FormRow label="SSL" htmlFor={`${ids}-ssl`} hint={sslHint}>
          <div className="relative">
            <select
              id={`${ids}-ssl`}
              data-testid="conn-ssl"
              className={cx(inputClass, "appearance-none pr-8")}
              value={fields.sslMode}
              onChange={(e) => {
                const mode = SSL_MODES.find((m) => m.value === e.target.value);
                if (mode) update({ sslMode: mode.value });
              }}
            >
              {SSL_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <IconSelector size={14} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-dim" />
          </div>
        </FormRow>
        <FormRow label="Name" htmlFor={`${ids}-name`} hint="Leave empty to use the host and database.">
          <input
            id={`${ids}-name`}
            data-testid="conn-name"
            autoFocus={existing !== undefined}
            className={inputClass}
            value={fields.name}
            onChange={set("name")}
            placeholder={fallbackName}
          />
        </FormRow>
        <FormRow label="Color" labelId={`${ids}-color`} hint="Marks this connection in the tree and the top bar.">
          <ColorPicker value={fields.color} onChange={(color) => update({ color })} labelledBy={`${ids}-color`} />
        </FormRow>
      </div>

      <div className="flex shrink-0 items-center gap-3 border-t border-border px-5 py-3">
        <Button data-testid="conn-test" disabled={!valid || probe.kind === "testing"} onClick={() => void test()}>
          Test
        </Button>
        <div data-testid="conn-test-result" data-state={probe.kind} className="min-w-0 flex-1 text-ui-12.5 leading-4">
          {probe.kind === "testing" && (
            <span className="flex items-center gap-2 text-dim">
              <Spinner /> Connecting
            </span>
          )}
          {probe.kind === "ok" && (
            <span className="flex items-center gap-1.5 text-fg">
              <IconCheck size={14} className="shrink-0 text-green" />
              <span className="truncate">Connected to PostgreSQL {probe.version}</span>
            </span>
          )}
          {probe.kind === "error" && <ErrorLine message={probe.message} />}
          {saveError && <ErrorLine message={saveError} />}
        </div>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button data-testid="conn-save" type="submit" variant="primary" disabled={!valid || saving}>
          {existing ? "Save" : "Save and connect"}
        </Button>
      </div>
    </form>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <span title={message} className="flex items-start gap-1.5 text-danger">
      <IconAlertCircle size={14} className="shrink-0" />
      <span className="line-clamp-2">{message}</span>
    </span>
  );
}

export function ConnectionDialog() {
  const overlay = useWorkspace((s) => s.overlay);
  const configs = useWorkspace((s) => s.configs);
  const close = useWorkspace((s) => s.close);
  const open = useWorkspace((s) => s.open);
  const editing = overlay.kind === "connection" ? overlay.editing : null;
  const existing = editing ? configs[editing] : undefined;
  const selected = existing ? editing : null;
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);

  const leave = (action: () => void) => {
    if (dirty) setPending(() => action);
    else action();
  };
  const select = (id: ConnectionId | null) => {
    if (id !== selected) leave(() => open({ kind: "connection", editing: id }));
  };
  const discard = () => {
    const action = pending;
    setPending(null);
    action?.();
  };

  return (
    <Dialog.Root open={overlay.kind === "connection"} onOpenChange={(o) => !o && leave(close)}>
      <Dialog.Portal>
        <DialogBackdrop />
        <Dialog.Content
          data-testid="connection-dialog"
          className="motion-pop fixed top-1/2 left-1/2 z-50 flex h-[560px] max-h-[calc(100vh-48px)] w-[760px] max-w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-control bg-raised shadow-[var(--shadow-dialog)] outline-none"
        >
          <ConnectionList selected={selected} onSelect={select} />
          <ConnectionForm key={editing ?? "new"} existing={existing} onSaved={close} onClose={() => leave(close)} onDirtyChange={setDirty} />
          <Modal
            open={pending !== null}
            onOpenChange={(o) => !o && setPending(null)}
            title="Discard unsaved changes?"
            description={existing ? `Your edits to ${existing.name} are lost.` : "This connection is not saved yet."}
            width={400}
            testId="discard-dialog"
            initialFocus={keepEditing}
          >
            <div className="flex justify-end gap-2">
              <Button ref={keepEditing} data-testid="discard-cancel" variant="ghost" onClick={() => setPending(null)}>
                Keep editing
              </Button>
              <Button data-testid="discard-confirm" variant="danger" onClick={discard}>
                Discard
              </Button>
            </div>
          </Modal>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

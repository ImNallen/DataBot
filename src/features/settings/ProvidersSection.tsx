import * as Menu from "@radix-ui/react-dropdown-menu";
import { IconArrowBackUp, IconInfoCircle, IconMinus, IconPlus, IconRefresh } from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { commands, type ProviderConfig, type ProviderInfo, type ProviderKind, type ProviderState } from "../../ipc/bindings";
import { useLive } from "../../state/live";
import { useWorkspace } from "../../state/workspace";
import { cx, IconButton, inputClass, MenuContent, MenuItem, MenuLabel, Switch } from "../../ui/primitives";
import { useNow } from "../../ui/useNow";
import { checkedAgo, outcomeVersion, providerStatus, type StatusTone } from "../assistant/assistantText";
import { PROVIDER_ICONS } from "../assistant/providerIcons";
import { saveSettings } from "../editor/runActions";
import { Row, SettingLabel } from "./SettingLayout";

/** Providers L1 Data plans to support, listed under "Add provider" until they ship. */
const UPCOMING = ["Codex"];

const TONE_CLASS = { ok: "text-dim", warn: "text-amber", error: "text-danger", muted: "text-dim" } satisfies Record<StatusTone, string>;

function saveProvider(kind: ProviderKind, patch: Partial<ProviderConfig>) {
  const providers = useWorkspace.getState().settings.providers.map((c) => (c.provider === kind ? { ...c, ...patch } : c));
  void saveSettings({ providers });
}

function defaultsOf(config: ProviderConfig, info: ProviderInfo): ProviderConfig {
  return { ...config, displayName: info.defaultName, binaryPath: "", configDir: "", launchArgs: "" };
}

function sameConfig(a: ProviderConfig, b: ProviderConfig): boolean {
  return a.displayName === b.displayName && a.binaryPath === b.binaryPath && a.configDir === b.configDir && a.launchArgs === b.launchArgs;
}

function AddProviderMenu({ present }: { present: readonly ProviderKind[] }) {
  const kinds = new Set<string>(present);
  const upcoming = UPCOMING.filter((name) => !kinds.has(name));
  return (
    <MenuContent>
      {upcoming.length === 0 && <MenuLabel>Every provider is added.</MenuLabel>}
      {upcoming.map((name) => (
        <MenuItem key={name} testId={`add-provider-${name}`} disabled>
          {name}
          <span className="ml-auto pl-4 text-ui-11.5 text-dim">Soon</span>
        </MenuItem>
      ))}
    </MenuContent>
  );
}

/** Commits on blur or Enter and restores on Escape. Key it on `value` so a saved change resets the draft. */
function TextField({
  id,
  testId,
  label,
  hint,
  value,
  placeholder,
  onCommit,
  below,
}: {
  id: string;
  testId: string;
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  onCommit: (next: string) => void;
  below?: ReactNode;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <div className="px-4 py-3.5">
      <label htmlFor={id} className="block">
        <span className="block text-ui-13 text-fg">{label}</span>
        <span className="mt-0.5 block text-ui-12 text-dim">{hint}</span>
      </label>
      <input
        id={id}
        data-testid={testId}
        spellCheck={false}
        autoComplete="off"
        className={cx(inputClass, "mt-2.5")}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onCommit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape" && draft !== value) {
            e.stopPropagation();
            setDraft(value);
          }
        }}
      />
      {below}
    </div>
  );
}

function ProviderRow({ config, state, selected, onSelect }: { config: ProviderConfig; state: ProviderState | undefined; selected: boolean; onSelect: () => void }) {
  const kind = config.provider;
  const Icon = PROVIDER_ICONS[kind];
  const version = outcomeVersion(state?.outcome);
  const status = providerStatus(state);
  return (
    <div className={cx("flex items-start gap-2 px-3 py-2.5", selected ? "bg-selected" : "hover:bg-hover")}>
      <button
        type="button"
        data-testid={`provider-row-${kind}`}
        aria-pressed={selected}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-start gap-2.5 rounded-sm text-left"
      >
        <Icon size={15} className="mt-0.5" />
        <span className="min-w-0">
          <span className="flex items-baseline gap-1.5">
            <span className="truncate text-ui-13 text-fg">{config.displayName}</span>
            {version && (
              <span data-testid={`provider-version-${kind}`} className="shrink-0 font-mono text-ui-11 text-dim">
                v{version}
              </span>
            )}
          </span>
          <span data-testid={`provider-status-${kind}`} title={status.text} className={cx("mt-0.5 block truncate text-ui-12", TONE_CLASS[status.tone])}>
            {status.text}
          </span>
        </span>
      </button>
      <Switch
        testId={`provider-toggle-${kind}`}
        label={`Use ${config.displayName}`}
        checked={config.enabled}
        onCheckedChange={(enabled) => saveProvider(kind, { enabled })}
      />
    </div>
  );
}

function ProviderDetail({ config, state }: { config: ProviderConfig; state: ProviderState | undefined }) {
  const kind = config.provider;
  const Icon = PROVIDER_ICONS[kind];
  if (!state) return <p className="px-4 py-6 text-ui-12.5 text-dim">L1 Data has not reported on {config.displayName} yet.</p>;
  const { info, outcome } = state;
  const version = outcomeVersion(outcome);
  const plan = outcome?.kind === "Ready" ? outcome.plan : null;
  const defaults = defaultsOf(config, info);
  const binary = info.defaultBinary;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 p-3">
      <div className="flex h-8 items-center gap-2 px-1">
        <Icon size={15} />
        <span className="min-w-0 flex-1 truncate text-ui-13 text-fg">{config.displayName}</span>
        {version && <span className="font-mono text-ui-11.5 text-dim">v{version}</span>}
        <IconButton
          data-testid="provider-reset"
          aria-label="Reset to defaults"
          title="Reset to defaults"
          className="size-6"
          disabled={sameConfig(config, defaults)}
          onClick={() => saveProvider(kind, defaults)}
        >
          <IconArrowBackUp size={14} />
        </IconButton>
      </div>
      <div className="rounded-xl border border-control">
        <TextField
          key={config.displayName}
          id="provider-display-name"
          testId="provider-display-name"
          label="Display name"
          hint={plan ? `Signed in with a ${plan} subscription.` : "The name L1 Data shows for this provider."}
          value={config.displayName}
          placeholder={info.defaultName}
          onCommit={(next) => saveProvider(kind, { displayName: next.trim() || info.defaultName })}
        />
      </div>
      <h3 className="mt-1 px-1 text-ui-13 text-fg">Runtime</h3>
      <div className="divide-y divide-border rounded-xl border border-control">
        <TextField
          key={`binary:${config.binaryPath}`}
          id="provider-binary-path"
          testId="provider-binary-path"
          label="Binary path"
          hint={`Path to the ${binary} binary L1 Data starts.`}
          value={config.binaryPath}
          placeholder={binary}
          onCommit={(next) => saveProvider(kind, { binaryPath: next.trim() })}
        />
        <TextField
          key={`config:${config.configDir}`}
          id="provider-config-dir"
          testId="provider-config-dir"
          label="Config directory"
          hint={`Where ${config.displayName} keeps its login and settings. Sets ${info.configEnv}.`}
          value={config.configDir}
          placeholder={info.configDirDefault}
          onCommit={(next) => saveProvider(kind, { configDir: next.trim() })}
        />
        <TextField
          key={`args:${config.launchArgs}`}
          id="provider-launch-args"
          testId="provider-launch-args"
          label="Launch arguments"
          hint={`Extra command-line arguments passed to ${binary} when a chat starts.`}
          value={config.launchArgs}
          placeholder="--model claude-opus-5-5"
          onCommit={(next) => saveProvider(kind, { launchArgs: next.trim() })}
          below={
            state.ignoredFlags.length > 0 && (
              <p data-testid="provider-launch-args-ignored" className="mt-1.5 text-ui-12 text-amber">
                Ignored: {state.ignoredFlags.join(", ")}
              </p>
            )
          }
        />
      </div>
    </div>
  );
}

export function ProviderListSetting() {
  const configs = useWorkspace((s) => s.settings.providers);
  const states = useLive((s) => s.providers);
  const [picked, setPicked] = useState<ProviderKind | null>(null);
  const now = useNow(true, 1000);
  const selected = configs.find((c) => c.provider === picked) ?? configs[0];
  const known = Object.values(states).filter((p) => p !== undefined);
  const checking = known.some((p) => p.checking);
  const present = configs.map((c) => c.provider);
  return (
    <section data-setting="providerList" aria-label="Providers">
      <div className="mb-2 flex items-center gap-1 px-1">
        <h2 className="text-ui-13 font-medium text-fg">
          <SettingLabel id="providerList" />
        </h2>
        <Menu.Root modal={false}>
          <Menu.Trigger asChild>
            <IconButton aria-label="Add provider" className="size-6">
              <IconPlus size={14} />
            </IconButton>
          </Menu.Trigger>
          <AddProviderMenu present={present} />
        </Menu.Root>
        <div className="flex-1" />
        <button
          type="button"
          data-testid="providers-refresh"
          title="Check every provider now"
          onClick={() => void commands.providerRefresh()}
          className="inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-ui-12 text-dim transition-colors hover:bg-hover hover:text-fg"
        >
          <IconRefresh size={13} className={cx(checking && "animate-spin")} />
          <span data-testid="providers-checked">{checkedAgo(known, now)}</span>
        </button>
      </div>
      <div className="flex min-h-[320px] overflow-hidden rounded-xl border border-control">
        <div className="flex w-[220px] shrink-0 flex-col border-r border-control">
          {configs.map((c) => (
            <ProviderRow key={c.provider} config={c} state={states[c.provider]} selected={c === selected} onSelect={() => setPicked(c.provider)} />
          ))}
          <Menu.Root modal={false}>
            <Menu.Trigger
              data-testid="add-provider"
              className="flex items-center gap-2.5 px-3 py-2.5 text-left text-ui-13 text-muted outline-none hover:bg-hover hover:text-fg data-[state=open]:bg-hover"
            >
              <IconPlus size={14} className="mx-px" />
              Add provider
            </Menu.Trigger>
            <AddProviderMenu present={present} />
          </Menu.Root>
        </div>
        {selected && <ProviderDetail key={selected.provider} config={selected} state={states[selected.provider]} />}
      </div>
    </section>
  );
}

const STEP_SECS = 30;

function SecondsStepper({ id, value }: { id: string; value: number }) {
  const [draft, setDraft] = useState(String(value));
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(String(value));
  }
  const save = (n: number) => {
    const next = Math.max(0, Math.round(n));
    setDraft(String(next));
    if (next !== value) void saveSettings({ providerHealthCheckSecs: next });
  };
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(n)) setDraft(String(value));
    else save(n);
  };
  const step = "grid h-full w-8 place-items-center text-muted transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40";
  return (
    <>
      <div className="flex h-8 items-stretch overflow-hidden rounded-lg border border-control">
        <button type="button" aria-label={`${STEP_SECS} seconds less`} disabled={value === 0} className={step} onClick={() => save(value - STEP_SECS)}>
          <IconMinus size={14} />
        </button>
        <input
          id={id}
          data-testid="setting-providerHealthCheck"
          inputMode="numeric"
          className="w-14 border-x border-control bg-bg text-center text-ui-13 text-fg tabular-nums outline-none focus:bg-hover"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape" && draft !== String(value)) {
              e.stopPropagation();
              setDraft(String(value));
            }
          }}
        />
        <button type="button" aria-label={`${STEP_SECS} seconds more`} className={step} onClick={() => save(value + STEP_SECS)}>
          <IconPlus size={14} />
        </button>
      </div>
      <span className="text-ui-13 text-dim">seconds</span>
    </>
  );
}

export function HealthCheckSetting() {
  const secs = useWorkspace((s) => s.settings.providerHealthCheckSecs);
  return (
    <Row
      setting="providerHealthCheck"
      labelFor="setting-provider-health-check"
      extra={
        <span title="Each check asks the CLI for its version and sign-in. It never starts a chat." className="text-faint">
          <IconInfoCircle size={13} />
        </span>
      }
      hint="Refresh provider status, versions and models in the background. Set to 0 to turn it off."
      control={<SecondsStepper id="setting-provider-health-check" value={secs} />}
    />
  );
}

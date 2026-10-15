import { useState, type ReactNode } from "react";
import { useWorkspace } from "../../state/workspace";
import { cx, inputClass } from "../../ui/primitives";
import { saveSettings } from "../editor/runActions";
import type { SettingId } from "./sections";

function SettingRow({ setting, id, label, hint, children }: { setting: SettingId; id: string; label: string; hint: string; children: ReactNode }) {
  return (
    <div data-setting={setting} className="flex items-center justify-between gap-6 border-b border-border py-4 first:pt-0 last:border-b-0">
      <label htmlFor={id} className="min-w-0">
        <span className="block text-ui-13 text-fg">{label}</span>
        <span className="mt-0.5 block text-ui-12 text-dim">{hint}</span>
      </label>
      {children}
    </div>
  );
}

function NumberInput({ id, field, value }: { id: string; field: "maxRows" | "tablePageSize"; value: number }) {
  const [draft, setDraft] = useState(String(value));
  const commit = () => {
    const n = Math.round(Number(draft));
    if (draft.trim() === "" || !Number.isFinite(n)) return setDraft(String(value));
    const next = Math.max(1, n);
    setDraft(String(next));
    if (next !== value) void saveSettings({ [field]: next });
  };
  return (
    <div className="w-28 shrink-0">
      <input
        id={id}
        data-testid={`setting-${field}`}
        type="number"
        min={1}
        className={cx(inputClass, "text-right tabular-nums")}
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
    </div>
  );
}

export function QueriesSection() {
  const settings = useWorkspace((s) => s.settings);
  return (
    <div>
      <SettingRow setting="maxRows" id="setting-max-rows" label="Row limit per result" hint="Rows past this are counted but not kept.">
        <NumberInput key={settings.maxRows} id="setting-max-rows" field="maxRows" value={settings.maxRows} />
      </SettingRow>
      <SettingRow setting="tablePageSize" id="setting-page-size" label="Table page size" hint="Rows per page when browsing a table.">
        <NumberInput key={settings.tablePageSize} id="setting-page-size" field="tablePageSize" value={settings.tablePageSize} />
      </SettingRow>
      <SettingRow setting="stopOnError" id="setting-stop-on-error" label="Stop a script at the first error" hint="Later statements are skipped once one fails.">
        <input
          id="setting-stop-on-error"
          data-testid="setting-stopOnError"
          type="checkbox"
          className="size-4 shrink-0 accent-run"
          checked={settings.stopOnError}
          onChange={(e) => void saveSettings({ stopOnError: e.target.checked })}
        />
      </SettingRow>
    </div>
  );
}

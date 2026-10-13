import { useEffect, useState } from "react";
import type { Settings } from "../ipc/bindings";
import { saveSettings } from "../features/editor/runActions";
import { useWorkspace } from "../state/workspace";
import { Button, inputClass, Modal } from "../ui/primitives";

function Toast() {
  const toast = useWorkspace((s) => s.toast);
  const [visible, setVisible] = useState<number | null>(null);
  useEffect(() => {
    if (!toast) return;
    setVisible(toast.id);
    const t = setTimeout(() => setVisible(null), 4_000);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast || visible !== toast.id) return null;
  return (
    <div
      role="status"
      data-testid="toast"
      className="fixed bottom-10 left-1/2 z-50 max-w-[520px] -translate-x-1/2 rounded-lg border border-control bg-raised px-3.5 py-2 text-[13px] text-fg shadow-[0_12px_32px_rgba(0,0,0,0.6)]"
    >
      {toast.text}
    </div>
  );
}

function SettingsForm({ initial, onDone }: { initial: Settings; onDone: () => void }) {
  const [draft, setDraft] = useState(initial);
  const save = async () => {
    await saveSettings(draft);
    onDone();
  };
  const numberField = (label: string, key: "maxRows" | "tablePageSize", hint: string) => (
    <label className="block">
      <span className="mb-1 block text-[12px] text-dim">{label}</span>
      <input
        type="number"
        min={1}
        className={inputClass}
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: Math.max(1, Number(e.target.value) || 1) })}
      />
      <span className="mt-1 block text-[11.5px] text-faint">{hint}</span>
    </label>
  );
  return (
    <div className="space-y-4">
      {numberField("Row limit per result", "maxRows", "Rows past this are counted but not kept.")}
      {numberField("Table page size", "tablePageSize", "Rows per page when browsing a table.")}
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={draft.stopOnError} onChange={(e) => setDraft({ ...draft, stopOnError: e.target.checked })} />
        Stop a script at the first error
      </label>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
}

export function Overlays() {
  const overlay = useWorkspace((s) => s.overlay);
  const settings = useWorkspace((s) => s.settings);
  const close = useWorkspace((s) => s.close);
  const onOpenChange = (open: boolean) => !open && close();

  return (
    <>
      <Modal open={overlay.kind === "settings"} onOpenChange={onOpenChange} title="Settings" width={400} testId="settings-dialog">
        <SettingsForm initial={settings} onDone={close} />
      </Modal>
      <Modal
        open={overlay.kind === "confirm"}
        onOpenChange={onOpenChange}
        title={overlay.kind === "confirm" ? overlay.title : ""}
        description={overlay.kind === "confirm" ? overlay.body : undefined}
        width={420}
        testId="confirm-dialog"
      >
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            data-testid="confirm-btn"
            variant="danger"
            onClick={() => {
              if (overlay.kind === "confirm") overlay.onConfirm();
              close();
            }}
          >
            {overlay.kind === "confirm" ? overlay.confirmLabel : ""}
          </Button>
        </div>
      </Modal>
      <Modal open={overlay.kind === "cell"} onOpenChange={onOpenChange} title={overlay.kind === "cell" ? overlay.title : ""} width={720} testId="cell-dialog">
        {overlay.kind === "cell" && (
          <pre className="selectable max-h-[52vh] overflow-auto rounded-lg border border-control bg-bg p-3 font-mono text-[12.5px] leading-5 whitespace-pre-wrap text-fg">
            {overlay.value ?? <span className="text-faint">NULL</span>}
          </pre>
        )}
      </Modal>
      <Toast />
    </>
  );
}

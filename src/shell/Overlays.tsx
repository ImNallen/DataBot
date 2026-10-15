import { useEffect, useState } from "react";
import { useWorkspace } from "../state/workspace";
import { Button, Modal } from "../ui/primitives";

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
      className="fixed bottom-10 left-1/2 z-50 max-w-[520px] -translate-x-1/2 rounded-lg border border-control bg-raised px-3.5 py-2 text-ui-13 text-fg shadow-[var(--shadow-popover)]"
    >
      {toast.text}
    </div>
  );
}

export function Overlays() {
  const overlay = useWorkspace((s) => s.overlay);
  const close = useWorkspace((s) => s.close);
  const onOpenChange = (open: boolean) => !open && close();

  return (
    <>
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
          <pre className="selectable max-h-[52vh] overflow-auto rounded-lg border border-control bg-bg p-3 font-mono text-ui-12.5 leading-5 whitespace-pre-wrap text-fg">
            {overlay.value ?? <span className="text-faint">NULL</span>}
          </pre>
        )}
      </Modal>
      <Toast />
    </>
  );
}

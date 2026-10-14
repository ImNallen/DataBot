import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { useWorkspace } from "../state/workspace";
import { handleLook } from "./ResizeHandle";

const COLUMNS = {
  sidebar: { key: "sidebarWidth", min: 200, max: 480, edge: "right", handle: "sidebar-resize", label: "Resize sidebar", line: "bg-hover" },
  right: { key: "rightPanelWidth", min: 260, max: 560, edge: "left", handle: "right-panel-resize", label: "Resize right panel", line: "bg-border" },
} as const;

export type Column = keyof typeof COLUMNS;

const STEP = 8;

export const clampWidth = (column: Column, px: number) => Math.round(Math.min(COLUMNS[column].max, Math.max(COLUMNS[column].min, px)));

// The side columns sit outside a panel Group because react-resizable-panels kept them as shares of the window,
// so their widths drifted whenever the window resized. Here the app owns each width in pixels. A column shrinks
// toward its minimum only when the window is too narrow to fit both columns beside the main area.
export function PixelColumn({ column, children }: { column: Column; children: ReactNode }) {
  const { key, min, max, edge, handle, label, line } = COLUMNS[column];
  const stored = useWorkspace((s) => s.layout[key]);
  const setLayout = useWorkspace((s) => s.setLayout);
  const [dragged, setDragged] = useState<number | null>(null);
  const drag = useRef<{ x: number; from: number; px: number } | null>(null);
  const width = dragged ?? clampWidth(column, stored);
  const toward = edge === "right" ? 1 : -1;

  const save = (px: number) => {
    if (px !== stored) setLayout({ [key]: px });
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, from: width, px: width };
    setDragged(width);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current.px = clampWidth(column, drag.current.from + toward * (e.clientX - drag.current.x));
    setDragged(drag.current.px);
  };
  const onPointerEnd = () => {
    if (!drag.current) return;
    save(drag.current.px);
    drag.current = null;
    setDragged(null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -STEP, ArrowRight: STEP }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    save(clampWidth(column, width + toward * step));
  };

  const look = handleLook("vertical", line);
  const separator = (
    <div
      id={handle}
      data-testid={handle}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-separator={dragged === null ? undefined : "active"}
      className={`${look.root} shrink-0 cursor-ew-resize`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onKeyDown={onKeyDown}
    >
      <div className={look.pill} />
    </div>
  );
  const body = (
    <div data-testid={column} className="h-full overflow-hidden" style={{ width, minWidth: min }}>
      {children}
    </div>
  );
  return edge === "right" ? (
    <>
      {body}
      {separator}
    </>
  ) : (
    <>
      {separator}
      {body}
    </>
  );
}

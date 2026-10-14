import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { useWorkspace } from "../state/workspace";
import { handleLook } from "./ResizeHandle";

const MIN = 200;
const MAX = 480;
const STEP = 8;

export const clampSidebarWidth = (px: number) => Math.round(Math.min(MAX, Math.max(MIN, px)));

const look = handleLook("vertical", "bg-hover");

// The sidebar sits outside the panel Group because react-resizable-panels kept it as a share of the window,
// so its width drifted whenever the window resized. Here the app owns the width in pixels.
export function SidebarColumn({ children }: { children: ReactNode }) {
  const stored = useWorkspace((s) => s.layout.sidebarWidth);
  const setLayout = useWorkspace((s) => s.setLayout);
  const [dragged, setDragged] = useState<number | null>(null);
  const drag = useRef<{ x: number; from: number; px: number } | null>(null);
  const width = dragged ?? clampSidebarWidth(stored);

  const save = (px: number) => {
    if (px !== stored) setLayout({ sidebarWidth: px });
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
    drag.current.px = clampSidebarWidth(drag.current.from + e.clientX - drag.current.x);
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
    save(clampSidebarWidth(width + step));
  };

  return (
    <>
      <div data-testid="sidebar" className="h-full shrink-0 overflow-hidden" style={{ width }}>
        {children}
      </div>
      <div
        id="sidebar-resize"
        data-testid="sidebar-resize"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={MIN}
        aria-valuemax={MAX}
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
    </>
  );
}

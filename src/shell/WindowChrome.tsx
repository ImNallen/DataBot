import { Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cx } from "../ui/primitives";
import {
  windowControlOrder,
  type HostedWindow,
  type ResizeEdge,
  type WindowControl,
} from "./hostedWindow";

function RestoreGlyph() {
  return (
    <span className="relative block size-3">
      <span className="absolute top-0 right-0 size-2 border border-current" />
      <span className="absolute bottom-0 left-0 size-2 border border-current bg-bg" />
    </span>
  );
}

function ControlGlyph({ control, maximized }: { control: WindowControl; maximized: boolean }) {
  if (control === "minimize") return <Minus size={14} />;
  if (control === "close") return <X size={14} />;
  if (maximized) return <RestoreGlyph />;
  return <Square size={11} />;
}

const CONTROL: Record<WindowControl, { label: (maximized: boolean) => string; run: (hosted: HostedWindow) => Promise<void> }> = {
  minimize: { label: () => "Minimize", run: (hosted) => hosted.minimize() },
  maximize: { label: (maximized) => (maximized ? "Restore" : "Maximize"), run: (hosted) => hosted.toggleMaximize() },
  close: { label: () => "Close", run: (hosted) => hosted.close() },
};

export function WindowControlButtons({ hosted, maximized }: { hosted: HostedWindow; maximized: boolean }) {
  return (
    <div className="flex items-center" data-testid="window-controls" data-side={hosted.side}>
      {windowControlOrder(hosted.side).map((control) => (
        <button
          key={control}
          type="button"
          data-testid={`window-${control}`}
          aria-label={CONTROL[control].label(maximized)}
          onClick={() => void CONTROL[control].run(hosted)}
          className={
            control === "close"
              ? "inline-grid size-7 place-items-center rounded-md text-muted hover:bg-danger hover:text-white"
              : "inline-grid size-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg"
          }
        >
          <ControlGlyph control={control} maximized={maximized} />
        </button>
      ))}
    </div>
  );
}

export function WindowControls({ hosted }: { hosted: HostedWindow }) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let current = true;
    let stop = () => {};
    void hosted.maximized().then((value) => {
      if (current) setMaximized(value);
    });
    void hosted.onResize(() => {
      void hosted.maximized().then((value) => {
        if (current) setMaximized(value);
      });
    }).then((unlisten) => {
      if (current) stop = unlisten;
      else unlisten();
    });
    return () => {
      current = false;
      stop();
    };
  }, [hosted]);
  return <WindowControlButtons hosted={hosted} maximized={maximized} />;
}

const EDGES: { edge: ResizeEdge; className: string }[] = [
  { edge: "North", className: "top-0 right-2 left-2 h-1 cursor-ns-resize" },
  { edge: "South", className: "right-2 bottom-0 left-2 h-1 cursor-ns-resize" },
  { edge: "West", className: "top-2 bottom-2 left-0 w-1 cursor-ew-resize" },
  { edge: "East", className: "top-2 right-0 bottom-2 w-1 cursor-ew-resize" },
  { edge: "NorthWest", className: "top-0 left-0 size-2 cursor-nwse-resize" },
  { edge: "NorthEast", className: "top-0 right-0 size-2 cursor-nesw-resize" },
  { edge: "SouthWest", className: "bottom-0 left-0 size-2 cursor-nesw-resize" },
  { edge: "SouthEast", className: "right-0 bottom-0 size-2 cursor-nwse-resize" },
];

export function ResizeEdges({ hosted }: { hosted: HostedWindow }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      {EDGES.map(({ edge, className }) => (
        <div
          key={edge}
          data-testid={`window-resize-${edge}`}
          className={cx("pointer-events-auto absolute", className)}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            void hosted.startResize(edge);
          }}
        />
      ))}
    </div>
  );
}

import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type WindowControl = "minimize" | "maximize" | "close";
export type WindowControlSide = "left" | "right";
export type ResizeEdge =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

export function windowControlSide(userAgent: string): WindowControlSide {
  return /Macintosh|Mac OS X/.test(userAgent) ? "left" : "right";
}

export function windowControlOrder(side: WindowControlSide): readonly WindowControl[] {
  return side === "left" ? ["close", "minimize", "maximize"] : ["minimize", "maximize", "close"];
}

export type HostedWindow = {
  side: WindowControlSide;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  maximized(): Promise<boolean>;
  onResize(fn: () => void): Promise<() => void>;
  startResize(edge: ResizeEdge): Promise<void>;
};

export function hostedWindow(userAgent?: string): HostedWindow | null {
  if (!isTauri()) return null;
  const win = getCurrentWindow();
  return {
    side: windowControlSide(userAgent ?? navigator.userAgent),
    minimize: () => win.minimize(),
    toggleMaximize: () => win.toggleMaximize(),
    close: () => win.close(),
    maximized: () => win.isMaximized(),
    onResize: (fn) => win.onResized(() => fn()),
    startResize: (edge) => win.startResizeDragging(edge),
  };
}

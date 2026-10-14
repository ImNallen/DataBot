import { cx } from "../ui/primitives";
import type { HostedWindow } from "./hostedWindow";
import { WindowEdgeActions, windowEdgeInset } from "./WindowEdgeActions";

export function RightPanel({ hosted }: { hosted: HostedWindow | null }) {
  return (
    <aside data-testid="right-panel" className="flex h-full flex-col bg-bg">
      <div
        data-tauri-drag-region="deep"
        className={cx("flex h-[52px] shrink-0 items-center gap-1 pl-3", windowEdgeInset(hosted))}
      >
        <span className="px-3 text-[14px] text-fg">Assistant</span>
        <div className="flex-1" />
        <WindowEdgeActions hosted={hosted} />
      </div>
      <div data-testid="assistant-placeholder" className="grid flex-1 place-items-center px-6 text-center text-[13px] text-dim">
        AI chat is coming soon.
      </div>
    </aside>
  );
}

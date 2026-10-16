import { IconMessagePlus } from "@tabler/icons-react";
import { AssistantPanel } from "../features/assistant/AssistantPanel";
import { newChat } from "../features/assistant/assistantActions";
import { ChatHistory } from "../features/assistant/ChatHistory";
import { cx, IconButton } from "../ui/primitives";
import type { HostedWindow } from "./hostedWindow";
import { WindowEdgeActions, windowEdgeInset } from "./WindowEdgeActions";

export function RightPanel({ hosted }: { hosted: HostedWindow | null }) {
  return (
    <aside data-testid="right-panel" className="flex h-full flex-col bg-bg">
      <div
        data-tauri-drag-region="deep"
        className={cx("flex h-[52px] shrink-0 items-center gap-1 pl-3", windowEdgeInset(hosted))}
      >
        <span className="px-3 text-ui-14 text-fg">Assistant</span>
        <div className="flex-1" />
        <IconButton data-testid="assistant-new" aria-label="New chat" title="New chat" onClick={() => void newChat()}>
          <IconMessagePlus size={16} />
        </IconButton>
        <ChatHistory />
        <div className="mx-1.5 h-5 w-px bg-border" />
        <WindowEdgeActions hosted={hosted} />
      </div>
      <AssistantPanel />
    </aside>
  );
}

import * as Menu from "@radix-ui/react-dropdown-menu";
import { IconHistory, IconTrash } from "@tabler/icons-react";
import { useMemo } from "react";
import type { ChatState } from "../../ipc/bindings";
import { useLive } from "../../state/live";
import { useWorkspace } from "../../state/workspace";
import { cx, IconButton, MenuContent, StatusDot } from "../../ui/primitives";
import { deleteChat, showChat } from "./assistantActions";
import { timeAgo } from "./assistantText";

/** Stored chats, newest first. Drafts are not stored and tombstones are gone. */
function listedChats(chats: Record<string, ChatState>): ChatState[] {
  return Object.values(chats)
    .filter((c) => c.status.kind !== "Draft" && c.status.kind !== "Deleted")
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

function HistoryItem({ chat, current, now }: { chat: ChatState; current: boolean; now: number }) {
  return (
    <Menu.Item
      data-testid={`chat-history-item-${chat.id}`}
      onSelect={() => void showChat(chat.id)}
      onKeyDown={(e) => {
        if (e.key !== "Delete" && e.key !== "Backspace") return;
        e.preventDefault();
        deleteChat(chat.id);
      }}
      className={cx(
        "group flex h-8 cursor-default items-center gap-2 rounded-md pr-1 pl-2 text-ui-13 outline-none data-[highlighted]:bg-selected",
        current ? "text-fg" : "text-muted data-[highlighted]:text-fg",
      )}
    >
      <span className="grid w-1.5 shrink-0 place-items-center">{chat.status.kind === "Running" && <StatusDot tone="pending" />}</span>
      <span className="min-w-0 flex-1 truncate">{chat.title || "Untitled chat"}</span>
      <span className="shrink-0 text-ui-11.5 text-dim group-hover:hidden group-data-[highlighted]:hidden">{timeAgo(now, chat.updatedAtMs)}</span>
      <IconButton
        aria-label={`Delete ${chat.title || "chat"}`}
        title="Delete chat"
        className="hidden size-6 group-hover:inline-grid group-data-[highlighted]:inline-grid"
        onClick={(e) => {
          e.stopPropagation();
          deleteChat(chat.id);
        }}
      >
        <IconTrash size={13} />
      </IconButton>
    </Menu.Item>
  );
}

export function ChatHistory() {
  const chats = useLive((s) => s.chats);
  const listed = useMemo(() => listedChats(chats), [chats]);
  const current = useWorkspace((s) => s.layout.assistantChat);
  const now = Date.now();
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger asChild>
        <IconButton data-testid="assistant-history" aria-label="Chat history" title="Chat history">
          <IconHistory size={16} />
        </IconButton>
      </Menu.Trigger>
      <MenuContent align="end" className="max-h-[420px] w-[300px] overflow-y-auto">
        {listed.length === 0 && <p className="px-2 py-1.5 text-ui-12.5 text-dim">No chats yet.</p>}
        {listed.map((c) => (
          <HistoryItem key={c.id} chat={c} current={c.id === current} now={now} />
        ))}
      </MenuContent>
    </Menu.Root>
  );
}

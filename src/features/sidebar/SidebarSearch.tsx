import { IconSearch } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { Kbd } from "../../ui/primitives";

export function SidebarSearch({ testId, label, onOpen, children }: { testId: string; label: string; onOpen: () => void; children?: ReactNode }) {
  return (
    <div className="mx-2 flex h-[34px] shrink-0 items-center gap-1">
      <button
        type="button"
        data-testid={testId}
        onClick={onOpen}
        className="group flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md pr-1.5 pl-2.5 text-left text-muted outline-none hover:bg-hover hover:text-fg"
      >
        <IconSearch size={15} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[13.5px]">{label}</span>
        <Kbd className="bg-border text-muted opacity-0 group-hover:opacity-100">⌘P</Kbd>
      </button>
      {children}
    </div>
  );
}

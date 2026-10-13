import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { IconBraces, IconColumns3, IconEye, IconSearch, IconTable } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useCatalog, type SearchItem } from "../../state/catalog";
import { useWorkspace } from "../../state/workspace";
import { DialogBackdrop } from "../../ui/primitives";
import { insertAtCursor } from "../editor/editorStates";
import { openTableTab } from "../editor/runActions";
import { fuzzyRank } from "./fuzzy";

const ICONS = {
  table: <IconTable size={15} className="text-muted" />,
  view: <IconEye size={15} className="text-muted" />,
  function: <IconBraces size={14} className="text-muted" />,
  column: <IconColumns3 size={14} className="text-muted" />,
} satisfies Record<SearchItem["kind"], React.ReactNode>;

function itemKey(item: SearchItem): string {
  return `${item.connectionId}:${item.schema}:${item.kind}:${item.label}`;
}

function choose(item: SearchItem) {
  const ws = useWorkspace.getState();
  switch (item.kind) {
    case "table":
    case "view":
    case "column":
      openTableTab({ connectionId: item.connectionId, schema: item.schema, relation: item.relation });
      return;
    case "function": {
      const tab = ws.active ? ws.tabs[ws.active] : undefined;
      if (tab?.kind === "sql") insertAtCursor(tab.id, `${item.name}()`);
      else ws.notify("Open a SQL tab to insert a function call.");
      return;
    }
    default: {
      const unreachable: never = item;
      return unreachable;
    }
  }
}

export function SearchPalette() {
  const open = useWorkspace((s) => s.overlay.kind === "palette");
  const close = useWorkspace((s) => s.close);
  const views = useCatalog((s) => s.views);
  const [query, setQuery] = useState("");

  const items = useMemo(() => Object.values(views).flatMap((v) => v.searchItems), [views]);
  const results = useMemo(
    () => (query.trim() ? fuzzyRank(query, items, (i) => i.label, 60) : items.filter((i) => i.kind !== "column").slice(0, 60)),
    [query, items],
  );
  const multiSchema = useMemo(() => new Set(items.map((i) => i.schema)).size > 1, [items]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
        setQuery("");
      }}
    >
      <Dialog.Portal>
        <DialogBackdrop />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[14%] left-1/2 z-50 w-[560px] -translate-x-1/2 overflow-hidden rounded-xl border border-control bg-raised shadow-[0_24px_64px_rgba(0,0,0,0.7)] outline-none"
        >
          <Dialog.Title className="sr-only">Search tables and columns</Dialog.Title>
          <Command shouldFilter={false} loop label="Search tables and columns">
            <div className="flex h-12 items-center gap-2.5 border-b border-control px-4">
              <IconSearch size={16} className="shrink-0 text-green" />
              <Command.Input
                data-testid="palette-input"
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder="Search tables, views, functions, and table.column"
                className="h-full flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-faint"
              />
            </div>
            <Command.List className="max-h-[360px] overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-[13px] text-dim">
                {items.length === 0 ? "Connect to a database to search its catalog." : `Nothing matches "${query}".`}
              </Command.Empty>
              {results.map((item) => (
                <Command.Item
                  key={itemKey(item)}
                  value={itemKey(item)}
                  data-testid={`palette-item-${item.label}`}
                  onSelect={() => {
                    close();
                    setQuery("");
                    choose(item);
                  }}
                  className="flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13.5px] text-fg data-[selected=true]:bg-selected"
                >
                  <span className="grid w-[18px] place-items-center">{ICONS[item.kind]}</span>
                  <span className="truncate">{item.label}</span>
                  {multiSchema && item.kind !== "column" && <span className="text-[12px] text-faint">{item.schema}</span>}
                  <span className="ml-auto truncate pl-4 font-mono text-[11.5px] text-dim">
                    {item.kind === "table" || item.kind === "view" ? item.kind : item.detail}
                  </span>
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

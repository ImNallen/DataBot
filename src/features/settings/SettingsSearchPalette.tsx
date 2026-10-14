import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { IconSearch } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useWorkspace } from "../../state/workspace";
import { DialogBackdrop } from "../../ui/primitives";
import { searchSettings } from "./sections";

export function SettingsSearchPalette() {
  const open = useWorkspace((s) => s.overlay.kind === "settings-search");
  const close = useWorkspace((s) => s.close);
  const openSettings = useWorkspace((s) => s.openSettings);
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchSettings(query), [query]);

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
          className="fixed top-[14%] left-1/2 z-50 w-[560px] -translate-x-1/2 overflow-hidden rounded-xl border border-control bg-raised shadow-[var(--shadow-dialog)] outline-none"
        >
          <Dialog.Title className="sr-only">Search settings</Dialog.Title>
          <Command shouldFilter={false} loop label="Search settings">
            <div className="flex h-12 items-center gap-2.5 border-b border-control px-4">
              <IconSearch size={16} className="shrink-0 text-green" />
              <Command.Input
                data-testid="settings-search-input"
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder="Search settings"
                className="h-full flex-1 bg-transparent text-ui-14 text-fg outline-none placeholder:text-faint"
              />
            </div>
            <Command.List className="max-h-[360px] overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-ui-13 text-dim">{`Nothing matches "${query}".`}</Command.Empty>
              {results.map(({ id, label, section, sectionLabel, icon: Icon }) => (
                <Command.Item
                  key={id}
                  value={id}
                  data-testid={`settings-search-item-${id}`}
                  onSelect={() => {
                    close();
                    setQuery("");
                    openSettings(section, id);
                  }}
                  className="flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-ui-13.5 text-fg data-[selected=true]:bg-selected"
                >
                  <span className="grid w-[18px] place-items-center">
                    <Icon size={15} className="text-muted" />
                  </span>
                  <span className="truncate">{label}</span>
                  <span className="ml-auto truncate pl-4 font-mono text-ui-11.5 text-dim">{sectionLabel}</span>
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

import { IconSearch, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useWorkspace } from "../../state/workspace";
import { cx, IconButton, Kbd } from "../../ui/primitives";

/** The sidebar's filter box. `count` is how many objects the query matches. */
export function SidebarSearch({
  testId,
  query,
  count,
  onQueryChange,
  onEnter,
  children,
}: {
  testId: string;
  query: string;
  count: number;
  onQueryChange: (query: string) => void;
  onEnter?: () => void;
  children?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  // A box that mounts after ⌘P revealed the sidebar still sees the request.
  const wantsFocus = useWorkspace((s) => s.searchFocus);
  useEffect(() => {
    if (!wantsFocus) return;
    input.current?.focus({ preventScroll: true });
    input.current?.select();
    useWorkspace.getState().searchFocused();
  }, [wantsFocus]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") onEnter?.();
    if (e.key !== "Escape") return;
    // An empty box lets Escape through, so it still leaves settings.
    if (query) {
      e.preventDefault();
      onQueryChange("");
    }
    e.currentTarget.blur();
  };

  return (
    <div className="mx-2 flex h-[34px] shrink-0 items-center gap-1">
      <label
        className={cx(
          "group flex h-full min-w-0 flex-1 cursor-text items-center gap-2.5 rounded-md border pr-1.5 pl-2.5 text-muted",
          focused ? "border-accent-border" : "border-transparent hover:bg-hover",
        )}
      >
        <IconSearch size={15} className="shrink-0" />
        <input
          ref={input}
          data-testid={testId}
          type="text"
          value={query}
          placeholder="Search"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onQueryChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          className="h-full min-w-0 flex-1 bg-transparent text-ui-13.5 text-fg outline-none placeholder:text-muted"
        />
        {query ? (
          <>
            <span data-testid={`${testId}-count`} className="shrink-0 text-ui-11.5 text-muted tabular-nums">
              {count}
            </span>
            <IconButton
              data-testid={`${testId}-clear`}
              aria-label="Clear search"
              className="size-5"
              onClick={() => {
                onQueryChange("");
                input.current?.focus();
              }}
            >
              <IconX size={13} />
            </IconButton>
          </>
        ) : (
          !focused && <Kbd className="bg-border text-muted opacity-0 group-hover:opacity-100">⌘P</Kbd>
        )}
      </label>
      {children}
    </div>
  );
}

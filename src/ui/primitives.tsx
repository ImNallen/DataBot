import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { IconCheck, IconChevronRight, IconX } from "@tabler/icons-react";
import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

const MENU_PANEL = "z-50 min-w-[180px] rounded-lg border border-control bg-raised p-1 shadow-[var(--shadow-popover)]";
const MENU_ITEM = "flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-ui-13 outline-none data-[highlighted]:bg-selected";

export function PgBadge() {
  return (
    <span className="inline-grid h-4 min-w-[18px] place-items-center rounded-[4px] bg-badge-bg px-[3px] font-mono text-ui-8.5 font-bold leading-none tracking-tight text-badge">
      PG
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cx("inline-flex h-[18px] items-center rounded-[4px] px-1.5 font-sans text-ui-10.5 font-medium leading-none", className)}>
      {children}
    </kbd>
  );
}

export function StatusDot({ tone }: { tone: "live" | "pending" | "off" | "error" }) {
  const color = { live: "bg-live", pending: "bg-amber animate-pulse", off: "bg-faint", error: "bg-danger" }[tone];
  return <span className={cx("inline-block size-1.5 shrink-0 rounded-full", color)} />;
}

export function Spinner() {
  return (
    <span
      className="inline-block size-3 rounded-full border-[1.5px] border-dim border-t-transparent"
      style={{ animation: "spin 0.8s linear infinite" }}
    />
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "ghost" | "outline" | "primary" | "danger" };

export function Button({ variant = "outline", className, ...rest }: ButtonProps) {
  const look = {
    ghost: "text-muted hover:bg-hover hover:text-fg",
    outline: "border border-control text-fg hover:bg-hover",
    primary: "bg-run text-run-fg hover:bg-run-hover",
    danger: "border border-control text-danger hover:bg-hover",
  }[variant];
  return (
    <button
      type="button"
      className={cx(
        "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-ui-13 whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-40",
        look,
        className,
      )}
      {...rest}
    />
  );
}

export function IconButton({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cx(
        "inline-grid size-7 place-items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
      {...rest}
    />
  );
}

export function DialogBackdrop() {
  return <Dialog.Overlay className="fixed inset-0 z-40 bg-backdrop/50 backdrop-blur-[6px]" />;
}

export function MenuContent({ children, align = "start" }: { children: ReactNode; align?: "start" | "end" }) {
  return (
    <Menu.Portal>
      <Menu.Content
        align={align}
        sideOffset={6}
        className={MENU_PANEL}
      >
        {children}
      </Menu.Content>
    </Menu.Portal>
  );
}

export function MenuItem({
  children,
  checked,
  onSelect,
  testId,
  danger,
  disabled,
}: {
  children: ReactNode;
  checked?: boolean;
  onSelect?: () => void;
  testId?: string;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <Menu.Item
      data-testid={testId}
      onSelect={onSelect}
      disabled={disabled}
      className={cx(MENU_ITEM, danger ? "text-danger" : "text-fg", "data-[disabled]:opacity-40")}
    >
      <span className="grid w-3.5 place-items-center">{checked && <IconCheck size={13} className="text-muted" />}</span>
      {children}
    </Menu.Item>
  );
}

export function ContextMenuArea({ menu, children }: { menu: ReactNode; children: ReactElement }) {
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={MENU_PANEL}>{menu}</ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function ContextMenuItem({ children, onSelect, testId }: { children: ReactNode; onSelect: () => void; testId?: string }) {
  return (
    <ContextMenu.Item data-testid={testId} onSelect={onSelect} className={cx(MENU_ITEM, "pr-3 text-fg")}>
      {children}
    </ContextMenu.Item>
  );
}

export function ContextSubmenu({ label, children, testId }: { label: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger data-testid={testId} className={cx(MENU_ITEM, "pr-1 text-fg data-[state=open]:bg-selected")}>
        {label}
        <IconChevronRight size={14} className="ml-auto text-muted" />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent sideOffset={6} alignOffset={-5} className={MENU_PANEL}>
          {children}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <Menu.Label className="px-2 pt-1.5 pb-1 text-ui-11.5 text-dim">{children}</Menu.Label>;
}

export function MenuSeparator() {
  return <Menu.Separator className="my-1 h-px bg-control" />;
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  width = 440,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  width?: number;
  testId?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <DialogBackdrop />
        <Dialog.Content
          data-testid={testId}
          style={{ width }}
          className="fixed top-[18%] left-1/2 z-50 max-h-[72vh] -translate-x-1/2 overflow-auto rounded-xl border border-control bg-raised p-5 shadow-[var(--shadow-dialog)] outline-none"
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-ui-14 font-semibold text-fg">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-1 text-ui-12.5 text-dim">{description}</Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">{title}</Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <IconButton aria-label="Close" className="-mt-1 -mr-1">
                <IconX size={15} />
              </IconButton>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const inputClass =
  "h-8 w-full rounded-lg border border-control bg-bg px-2.5 text-ui-13 text-fg outline-none placeholder:text-faint focus:border-accent-border";

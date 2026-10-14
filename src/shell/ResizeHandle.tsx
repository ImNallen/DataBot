import { Separator } from "react-resizable-panels";
import { cx } from "../ui/primitives";

// The line runs vertically between side-by-side panels and horizontally between stacked ones.
const LINE = {
  vertical: {
    line: "w-px after:inset-y-0 after:-inset-x-1",
    pill: "top-1/2 -left-0.5 h-8 w-[5px] -translate-y-1/2",
  },
  horizontal: {
    line: "h-px after:inset-x-0 after:-inset-y-1",
    pill: "left-1/2 -top-0.5 h-[5px] w-8 -translate-x-1/2",
  },
} as const;

export const handleLook = (line: keyof typeof LINE, lineColor: string) => ({
  root: cx("group relative z-10 outline-none after:absolute", LINE[line].line, lineColor),
  pill: cx(
    "pointer-events-none absolute rounded-full bg-handle transition-colors group-hover:bg-handle-hover group-focus-visible:bg-handle-hover group-data-[separator=focus]:bg-handle-hover group-data-[separator=hover]:bg-handle-hover group-data-[separator=active]:bg-run",
    LINE[line].pill,
  ),
});

export function ResizeHandle({
  id,
  label,
  line,
  lineColor,
}: {
  id: string;
  label: string;
  line: keyof typeof LINE;
  lineColor: string;
}) {
  const look = handleLook(line, lineColor);
  return (
    <Separator id={id} aria-label={label} className={look.root}>
      <div className={look.pill} />
    </Separator>
  );
}

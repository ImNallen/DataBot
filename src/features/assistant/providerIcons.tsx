import type { ComponentType } from "react";
import type { ProviderKind } from "../../ipc/bindings";
import { cx } from "../../ui/primitives";

type MarkProps = { size?: number; className?: string };

const RAYS = Array.from({ length: 12 }, (_, i) => {
  const angle = ((i * 30 + 8) * Math.PI) / 180;
  const reach = i % 2 === 0 ? 10.5 : 8.6;
  return { x1: 12 + 1.6 * Math.cos(angle), y1: 12 + 1.6 * Math.sin(angle), x2: 12 + reach * Math.cos(angle), y2: 12 + reach * Math.sin(angle) };
});

function ClaudeMark({ size = 16, className }: MarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className={cx("shrink-0 text-claude", className)}>
      <g stroke="currentColor" strokeWidth={2.3} strokeLinecap="round">
        {RAYS.map((r, i) => (
          <line key={i} {...r} />
        ))}
      </g>
    </svg>
  );
}

export const PROVIDER_ICONS = { Claude: ClaudeMark } satisfies Record<ProviderKind, ComponentType<MarkProps>>;

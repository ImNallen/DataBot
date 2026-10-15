import { useId, type ReactNode } from "react";
import { settingLabel, type SettingId } from "./settingsIndex";

export function SettingLabel({ id }: { id: SettingId }) {
  return settingLabel(id);
}

export function Card({ title, children }: { title: ReactNode; children: ReactNode }) {
  const heading = useId();
  return (
    <section aria-labelledby={heading}>
      <h2 id={heading} className="mb-2 flex items-center gap-2 px-1 text-ui-13 font-medium text-fg">
        {title}
      </h2>
      <div className="divide-y divide-border rounded-xl border border-control">{children}</div>
    </section>
  );
}

/** One setting in a card. `labelFor` makes the label name and click through to that control. */
export function Row({
  setting,
  hint,
  control,
  labelFor,
  extra,
  children,
}: {
  setting: SettingId;
  hint: string;
  control: ReactNode;
  labelFor?: string;
  /** UI that sits after the label, such as a reset button. */
  extra?: ReactNode;
  children?: ReactNode;
}) {
  const text = (
    <>
      <span className="flex items-center gap-1 text-ui-13 text-fg">
        <SettingLabel id={setting} />
        {extra}
      </span>
      <span className="mt-0.5 block text-ui-12 text-dim">{hint}</span>
    </>
  );
  return (
    <div data-setting={setting} className="px-4 py-3.5">
      <div className="flex items-center justify-between gap-6">
        {labelFor ? (
          <label htmlFor={labelFor} className="min-w-0">
            {text}
          </label>
        ) : (
          <div className="min-w-0">{text}</div>
        )}
        <div className="flex shrink-0 items-center gap-2">{control}</div>
      </div>
      {children}
    </div>
  );
}

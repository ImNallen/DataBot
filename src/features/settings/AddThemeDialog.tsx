import { IconDownload, IconPlus } from "@tabler/icons-react";
import { useRef, useState, type DragEvent } from "react";
import { useWorkspace } from "../../state/workspace";
import type { ThemeDraft } from "../../themes/catalog";
import { parseThemeFile } from "../../themes/importers";
import { Button, cx, inputClass, Modal } from "../../ui/primitives";
import { addCustomThemes } from "./themeActions";

const EXAMPLE = `{
  "version": 1,
  "name": "Aurora",
  "appearance": "light",
  "colors": { "background": "#fbfaff", "accent": "#7c3aed" }
}`;

export async function addThemes(drafts: readonly ThemeDraft[]): Promise<void> {
  await addCustomThemes(drafts);
  const names = drafts.map((d) => d.name);
  useWorkspace.getState().notify(names.length === 1 ? `Added ${names[0]}.` : `Added ${names.length} themes.`);
}

async function readFiles(files: readonly File[]): Promise<{ drafts: ThemeDraft[]; errors: string[] }> {
  const results = await Promise.all(files.map(async (f) => ({ name: f.name, result: parseThemeFile(await f.text(), f.name) })));
  return {
    drafts: results.flatMap(({ result }) => (result.ok ? result.themes : [])),
    errors: results.flatMap(({ name, result }) => (result.ok ? [] : [`${name}: ${result.error}`])),
  };
}

export function AddThemeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [json, setJson] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const close = () => {
    setJson("");
    setErrors([]);
    onOpenChange(false);
  };
  const importFiles = async (files: readonly File[]) => {
    const { drafts, errors } = await readFiles(files);
    if (drafts.length > 0) await addThemes(drafts);
    if (errors.length > 0) setErrors(errors);
    else close();
  };
  const importJson = async () => {
    const result = parseThemeFile(json);
    if (!result.ok) return setErrors([result.error]);
    await addThemes(result.themes);
    close();
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void importFiles([...e.dataTransfer.files]);
  };

  return (
    <Modal open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())} title="Add a theme" width={560} testId="add-theme-dialog">
      <div className="flex flex-col gap-4">
        <div
          data-testid="theme-drop-zone"
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cx("flex items-center justify-between gap-4 rounded-lg border border-dashed px-4 py-3", dragging ? "border-run bg-hover" : "border-control")}
        >
          <div>
            <span className="block text-[13px] text-fg">Theme file</span>
            <span className="block text-[12px] text-dim">Drop L1 or VS Code .json files</span>
          </div>
          <Button onClick={() => picker.current?.click()}>
            <IconDownload size={14} />
            Choose files
          </Button>
          <input
            ref={picker}
            type="file"
            multiple
            accept=".json,.jsonc,application/json"
            data-testid="theme-file-input"
            className="hidden"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              if (files.length > 0) void importFiles(files);
            }}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="theme-json" className="text-[13px] text-fg">
            Theme JSON
          </label>
          <textarea
            id="theme-json"
            data-testid="theme-json"
            spellCheck={false}
            rows={5}
            placeholder={EXAMPLE}
            value={json}
            onChange={(e) => {
              setJson(e.target.value);
              setErrors([]);
            }}
            className={cx(inputClass, "h-auto resize-y py-2 font-mono text-[12px] leading-[18px]")}
          />
        </div>
        {errors.length > 0 && (
          <ul data-testid="add-theme-errors" role="alert" className="flex flex-col gap-1 text-[12px] text-danger">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        <div className="sticky -bottom-5 -mx-5 -mb-5 flex justify-end gap-2 border-t border-border bg-raised px-5 py-3">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" data-testid="add-theme-save" disabled={!json.trim()} onClick={() => void importJson()}>
            <IconPlus size={14} />
            Add theme
          </Button>
        </div>
      </div>
    </Modal>
  );
}

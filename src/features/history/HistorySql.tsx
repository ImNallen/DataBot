import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { editorHighlighting, editorTheme, functionCallStyle } from "../editor/theme";

export function HistorySql({ text }: { text: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorState.readOnly.of(true), EditorView.editable.of(false),
          EditorView.contentAttributes.of({ "aria-label": "Saved SQL", tabindex: "0" }),
          lineNumbers(), drawSelection(), EditorView.lineWrapping,
          sql({ dialect: PostgreSQL }), editorTheme, editorHighlighting, functionCallStyle,
        ],
      }),
    });
    return () => view.destroy();
  }, [text]);
  return <div ref={host} data-testid="history-sql" className="h-full min-h-0" />;
}

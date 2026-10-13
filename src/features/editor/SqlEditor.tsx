import { useEffect, useLayoutEffect, useRef } from "react";
import type { TabId } from "../../ipc/bindings";
import { useCatalog } from "../../state/catalog";
import { useWorkspace } from "../../state/workspace";
import { activateEditor, configureSql, focusEditor, mountEditor } from "./editorStates";

export function SqlEditor({ tabId }: { tabId: TabId }) {
  const host = useRef<HTMLDivElement>(null);
  const tab = useWorkspace((s) => s.tabs[tabId]);
  const connectionId = tab?.kind === "sql" ? tab.console.connectionId : null;
  const schema = tab?.kind === "sql" ? (tab.console.schema ?? "public") : undefined;
  const completion = useCatalog((s) => (connectionId ? s.views[connectionId]?.completion : undefined));

  useLayoutEffect(() => {
    activateEditor(tabId);
  }, [tabId]);

  useEffect(() => {
    if (!host.current) return;
    return mountEditor(host.current);
  }, []);

  useEffect(() => {
    configureSql(tabId, completion, schema);
  }, [tabId, completion, schema]);

  useEffect(() => {
    focusEditor();
  }, [tabId]);

  return <div ref={host} data-testid="sql-editor" className="h-full min-h-0 bg-bg" />;
}

import { useEffect, useLayoutEffect, useRef } from "react";
import type { TabId } from "../../ipc/bindings";
import { useCatalog } from "../../state/catalog";
import { tabConnectionId, useWorkspace } from "../../state/workspace";
import { activateEditor, configureSql, focusEditor, mountEditor } from "./editorStates";

export function SqlEditor({ tabId }: { tabId: TabId }) {
  const host = useRef<HTMLDivElement>(null);
  const tab = useWorkspace((s) => s.tabs[tabId]);
  const connectionId = tabConnectionId(tab);
  const view = useCatalog((s) => (connectionId ? s.views[connectionId] : undefined));

  useLayoutEffect(() => {
    activateEditor(tabId);
  }, [tabId]);

  useEffect(() => {
    if (!host.current) return;
    return mountEditor(host.current);
  }, []);

  useEffect(() => {
    configureSql(tabId, view?.completion, view?.qualifiedTables ?? []);
  }, [tabId, view]);

  useEffect(() => {
    focusEditor();
  }, [tabId]);

  return <div ref={host} data-testid="sql-editor" className="h-full min-h-0 bg-bg" />;
}

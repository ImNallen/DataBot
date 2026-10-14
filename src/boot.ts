import { listen } from "@tauri-apps/api/event";
import { commands, type AppEvent } from "./ipc/bindings";
import { useCatalog } from "./state/catalog";
import { useLive, type LiveData } from "./state/live";
import { useWorkspace, workspaceSnapshot } from "./state/workspace";
import { startTheme } from "./shell/theme";
import { seedEditor, textOf } from "./features/editor/editorStates";
import { browseQuery, installRunBehavior, onEditorDocChanged, openSqlTab } from "./features/editor/runActions";

const SAVE_DEBOUNCE_MS = 500;

function startPersistence() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void commands.workspaceSave(workspaceSnapshot(useWorkspace.getState(), textOf)), SAVE_DEBOUNCE_MS);
  };
  useWorkspace.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs || s.order !== prev.order || s.active !== prev.active || s.layout !== prev.layout) schedule();
  });
  onEditorDocChanged(schedule);
}

function startCatalogSync() {
  const sync = (s: LiveData) => {
    for (const [id, conn] of Object.entries(s.connections)) {
      const version = s.catalogVersions[id];
      if (conn.status.kind === "Connected" && version !== undefined) void useCatalog.getState().ensure(id, version);
    }
  };
  useLive.subscribe((s, prev) => {
    if (s.connections !== prev.connections || s.catalogVersions !== prev.catalogVersions) sync(s);
  });
  sync(useLive.getState());
}

export async function boot(): Promise<void> {
  installRunBehavior();
  await listen<AppEvent>("app-event", (e) => useLive.getState().apply(e.payload));
  const snapshot = await commands.appBoot();
  useLive.getState().hydrate(snapshot);
  for (const tab of snapshot.workspace.tabs) seedEditor(tab.id, tab.kind === "Sql" ? tab.text : browseQuery(tab.schema, tab.table));
  useWorkspace.getState().restore(snapshot.workspace, snapshot.connections, snapshot.settings);
  startTheme();
  if (snapshot.workspace.tabs.length === 0) openSqlTab();
  startPersistence();
  startCatalogSync();
}

import { listen } from "@tauri-apps/api/event";
import { commands, type AppEvent } from "./ipc/bindings";
import { useCatalog } from "./state/catalog";
import { useLive, wantedCatalogs, type LiveData } from "./state/live";
import { useRelationDetail } from "./state/relationDetail";
import { useWorkspace, workspaceSnapshot } from "./state/workspace";
import { startAppearance } from "./shell/appearance";
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

/** The catalog store holds exactly the catalogs the connection snapshots serve, and the detail store only their relations. */
function startCatalogSync() {
  const sync = (s: LiveData) => {
    const wanted = wantedCatalogs(s.connections);
    const catalog = useCatalog.getState();
    catalog.prune(new Set(wanted.keys()));
    for (const { ref, version } of wanted.values()) void catalog.ensure(ref, version);
  };
  useLive.subscribe((s, prev) => {
    if (s.connections !== prev.connections) sync(s);
  });
  useCatalog.subscribe((s, prev) => {
    if (s.views !== prev.views) useRelationDetail.getState().prune(s.views);
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
  startAppearance();
  if (snapshot.workspace.tabs.length === 0) openSqlTab();
  startPersistence();
  startCatalogSync();
}

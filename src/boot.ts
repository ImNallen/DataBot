import { listen } from "@tauri-apps/api/event";
import { commands, type AppEvent } from "./ipc/bindings";
import { useCatalog } from "./state/catalog";
import { useLive, type LiveData } from "./state/live";
import { useWorkspace } from "./state/workspace";
import { seedEditor } from "./features/editor/editorStates";
import { installRunBehavior, openSqlTab } from "./features/editor/runActions";

/** Keeps each connected connection's catalog at the newest announced version. */
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
  // Listen first, then snapshot: an event racing the snapshot is harmless because apply keeps the higher rev.
  await listen<AppEvent>("app-event", (e) => useLive.getState().apply(e.payload));
  const snapshot = await commands.appBoot();
  useLive.getState().hydrate(snapshot);
  for (const tab of snapshot.workspace.tabs) if (tab.kind === "Sql") seedEditor(tab.id, tab.text);
  useWorkspace.getState().restore(snapshot.workspace, snapshot.connections, snapshot.settings);
  if (snapshot.workspace.tabs.length === 0) openSqlTab();
  startCatalogSync();
}

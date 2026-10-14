import { useEffect, useRef, useState } from "react";
import { Group, Panel, type PanelSize } from "react-resizable-panels";
import { ConnectionDialog } from "../features/connections/ConnectionDialog";
import { SqlEditor } from "../features/editor/SqlEditor";
import { closeTab, openSqlTab } from "../features/editor/runActions";
import { HistoryPalette } from "../features/history/HistoryPalette";
import { ResultsPane } from "../features/results/ResultsPane";
import { SearchPalette } from "../features/sidebar/SearchPalette";
import { Sidebar } from "../features/sidebar/Sidebar";
import { useWorkspace } from "../state/workspace";
import { Button } from "../ui/primitives";
import { Overlays } from "./Overlays";
import { ResizeHandle } from "./ResizeHandle";
import { RightPanel } from "./RightPanel";
import { StatusBar } from "./StatusBar";
import { TabBar } from "./TabBar";
import { ResizeEdges } from "./WindowChrome";
import { hostedWindow } from "./hostedWindow";
import { TopBar } from "./TopBar";

function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        useWorkspace.getState().open({ kind: "palette" });
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        const active = useWorkspace.getState().active;
        if (active) void closeTab(active);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

// Saved on release only: a store update mid-drag re-renders the Group and the library drops the drag.
function usePersistedPixels(key: "sidebarWidth" | "rightPanelWidth" | "resultsHeight") {
  const px = useRef<number | null>(null);
  return {
    onResize: (size: PanelSize) => {
      px.current = Math.round(size.inPixels);
    },
    onLayoutChanged: () => {
      const { layout, setLayout } = useWorkspace.getState();
      if (px.current !== null && px.current !== layout[key]) setLayout({ [key]: px.current });
    },
  };
}

function MainArea() {
  const active = useWorkspace((s) => (s.active ? s.tabs[s.active] : undefined));
  const showResults = useWorkspace((s) => s.layout.results);
  const resultsHeight = useWorkspace((s) => s.layout.resultsHeight);
  const resultsSize = usePersistedPixels("resultsHeight");

  if (!active) {
    return (
      <div className="grid flex-1 place-items-center bg-bg">
        <div className="flex flex-col items-center gap-3 text-dim">
          <span>No open tabs.</span>
          <Button onClick={() => openSqlTab()}>New SQL tab</Button>
        </div>
      </div>
    );
  }
  return (
    <Group orientation="vertical" className="min-h-0 flex-1" onLayoutChanged={resultsSize.onLayoutChanged}>
      <Panel id="editor" minSize={80}>
        <SqlEditor tabId={active.id} />
      </Panel>
      {showResults && (
        <>
          <ResizeHandle id="results-resize" label="Resize results" line="horizontal" lineColor="bg-border" />
          <Panel
            id="results"
            defaultSize={resultsHeight}
            minSize={120}
            groupResizeBehavior="preserve-pixel-size"
            onResize={resultsSize.onResize}
          >
            <ResultsPane tabId={active.id} />
          </Panel>
        </>
      )}
    </Group>
  );
}

export function AppLayout() {
  useGlobalKeys();
  const [hosted] = useState(() => hostedWindow());
  const sidebar = useWorkspace((s) => s.layout.sidebar);
  const sidebarWidth = useWorkspace((s) => s.layout.sidebarWidth);
  const sidebarSize = usePersistedPixels("sidebarWidth");
  const rightPanel = useWorkspace((s) => s.layout.rightPanel);
  const rightPanelWidth = useWorkspace((s) => s.layout.rightPanelWidth);
  const rightPanelSize = usePersistedPixels("rightPanelWidth");
  const persistWidths = () => {
    sidebarSize.onLayoutChanged();
    rightPanelSize.onLayoutChanged();
  };

  return (
    <div className="relative flex h-full">
      {hosted?.chrome === "custom" && <ResizeEdges hosted={hosted} />}
      <Group orientation="horizontal" className="min-w-0 flex-1" onLayoutChanged={persistWidths}>
        {sidebar && (
          <>
            <Panel
              id="sidebar"
              defaultSize={sidebarWidth}
              minSize={200}
              maxSize={480}
              groupResizeBehavior="preserve-pixel-size"
              onResize={sidebarSize.onResize}
            >
              <Sidebar hosted={hosted} />
            </Panel>
            <ResizeHandle id="sidebar-resize" label="Resize sidebar" line="vertical" lineColor="bg-hover" />
          </>
        )}
        <Panel id="main" className="flex min-w-0 flex-col bg-bg">
          <TopBar hosted={hosted} />
          <TabBar />
          <MainArea />
          <StatusBar />
        </Panel>
        {rightPanel && (
          <>
            <ResizeHandle id="right-panel-resize" label="Resize right panel" line="vertical" lineColor="bg-border" />
            <Panel
              id="right"
              defaultSize={rightPanelWidth}
              minSize={260}
              maxSize={560}
              groupResizeBehavior="preserve-pixel-size"
              onResize={rightPanelSize.onResize}
            >
              <RightPanel hosted={hosted} />
            </Panel>
          </>
        )}
      </Group>
      <SearchPalette />
      <HistoryPalette />
      <ConnectionDialog />
      <Overlays />
    </div>
  );
}

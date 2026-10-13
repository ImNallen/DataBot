import { useEffect, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { ConnectionDialog } from "../features/connections/ConnectionDialog";
import { SqlEditor } from "../features/editor/SqlEditor";
import { openSqlTab } from "../features/editor/runActions";
import { RightPanel } from "./RightPanel";
import { ResultsPane } from "../features/results/ResultsPane";
import { SearchPalette } from "../features/sidebar/SearchPalette";
import { Sidebar } from "../features/sidebar/Sidebar";
import { useWorkspace } from "../state/workspace";
import { Button } from "../ui/primitives";
import { Overlays } from "./Overlays";
import { StatusBar } from "./StatusBar";
import { TabBar } from "./TabBar";
import { ResizeEdges } from "./WindowChrome";
import { appTitleAlign, hostedWindow } from "./windowChrome";
import { TopBar } from "./TopBar";

function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        useWorkspace.getState().open({ kind: "palette" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function MainArea() {
  const active = useWorkspace((s) => (s.active ? s.tabs[s.active] : undefined));
  const showResults = useWorkspace((s) => s.layout.results);
  const resultsHeight = useWorkspace((s) => s.layout.resultsHeight);

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
  if (active.kind === "table") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ResultsPane tabId={active.id} />
      </div>
    );
  }
  return (
    <Group orientation="vertical" className="min-h-0 flex-1">
      <Panel id="editor" minSize={80}>
        <SqlEditor tabId={active.id} />
      </Panel>
      {showResults && (
        <>
          <Separator className="relative h-px bg-border outline-none after:absolute after:inset-x-0 after:-top-1 after:-bottom-1 data-[separator=active]:bg-run data-[separator=hover]:bg-[#2a2a2a]" />
          <Panel
            id="results"
            defaultSize={resultsHeight}
            minSize={120}
            groupResizeBehavior="preserve-pixel-size"
            onResize={(size, _id, prev) => {
              if (prev) useWorkspace.getState().setLayout({ resultsHeight: Math.round(size.inPixels) });
            }}
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
  const [titleAlign] = useState(() => appTitleAlign(navigator.userAgent));
  const sidebar = useWorkspace((s) => s.layout.sidebar);
  const rightPanel = useWorkspace((s) => s.layout.rightPanel);

  return (
    <div className="relative flex h-full">
      {hosted && <ResizeEdges hosted={hosted} />}
      {sidebar && <Sidebar titleAlign={titleAlign} />}
      <div className="flex min-w-0 flex-1 flex-col bg-bg">
        <TopBar hosted={hosted} />
        <TabBar />
        <MainArea />
        <StatusBar />
      </div>
      {rightPanel && <RightPanel panel={rightPanel} />}
      <SearchPalette />
      <ConnectionDialog />
      <Overlays />
    </div>
  );
}

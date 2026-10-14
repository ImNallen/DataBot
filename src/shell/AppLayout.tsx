import { useEffect, useRef, useState, type ReactNode } from "react";
import { Group, Panel, type PanelSize } from "react-resizable-panels";
import { ConnectionDialog } from "../features/connections/ConnectionDialog";
import { SqlEditor } from "../features/editor/SqlEditor";
import { HistoryPalette } from "../features/history/HistoryPalette";
import { ResultsPane } from "../features/results/ResultsPane";
import { SettingsNav, SettingsPage } from "../features/settings/SettingsScreen";
import { SearchPalette } from "../features/sidebar/SearchPalette";
import { Sidebar } from "../features/sidebar/Sidebar";
import { useWorkspace, type Screen } from "../state/workspace";
import { Kbd } from "../ui/primitives";
import { START_COMMANDS, commandForKey, shortcutLabel } from "./commands";
import { Overlays } from "./Overlays";
import { ResizeHandle } from "./ResizeHandle";
import { RightPanel } from "./RightPanel";
import { StatusBar } from "./StatusBar";
import { TabBar } from "./TabBar";
import { ResizeEdges } from "./WindowChrome";
import { hostedWindow, type HostedWindow } from "./hostedWindow";
import { TopBar } from "./TopBar";

function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const command = commandForKey(e);
      if (!command) return;
      e.preventDefault();
      command.run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function StartCommands() {
  return (
    <div data-testid="no-tabs" className="grid h-full place-items-center bg-bg">
      <ul className="flex w-[260px] flex-col gap-0.5">
        {START_COMMANDS.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              data-testid={`start-${c.id}`}
              onClick={c.run}
              className="flex h-8 w-full items-center justify-between rounded-md px-2.5 text-[13.5px] text-muted hover:bg-hover hover:text-fg"
            >
              {c.label}
              <Kbd className="bg-border text-muted">{shortcutLabel(c)}</Kbd>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
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

  return (
    <Group orientation="vertical" className="min-h-0 flex-1" onLayoutChanged={resultsSize.onLayoutChanged}>
      <Panel id="editor" minSize={80}>
        {active ? (
          <SqlEditor tabId={active.id} />
        ) : (
          <StartCommands />
        )}
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
            <ResultsPane tabId={active?.id ?? null} />
          </Panel>
        </>
      )}
    </Group>
  );
}

type ScreenPanels = { side: ReactNode; main: ReactNode; right: boolean };

function screenPanels(screen: Screen, hosted: HostedWindow | null, sidebar: boolean): ScreenPanels {
  switch (screen.kind) {
    case "workspace":
      return {
        side: sidebar ? <Sidebar hosted={hosted} /> : null,
        main: (
          <>
            <TopBar hosted={hosted} />
            <TabBar />
            <MainArea />
            <StatusBar />
          </>
        ),
        right: true,
      };
    case "settings":
      return {
        side: <SettingsNav hosted={hosted} section={screen.section} />,
        main: <SettingsPage hosted={hosted} section={screen.section} />,
        right: false,
      };
    default: {
      const unreachable: never = screen;
      return unreachable;
    }
  }
}

export function AppLayout() {
  useGlobalKeys();
  const [hosted] = useState(() => hostedWindow());
  const screen = useWorkspace((s) => s.screen);
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
  const panels = screenPanels(screen, hosted, sidebar);

  return (
    <div className="relative flex h-full">
      {hosted?.chrome === "custom" && <ResizeEdges hosted={hosted} />}
      <Group orientation="horizontal" className="min-w-0 flex-1" onLayoutChanged={persistWidths}>
        {panels.side && (
          <>
            <Panel
              id="sidebar"
              defaultSize={sidebarWidth}
              minSize={200}
              maxSize={480}
              groupResizeBehavior="preserve-pixel-size"
              onResize={sidebarSize.onResize}
            >
              {panels.side}
            </Panel>
            <ResizeHandle id="sidebar-resize" label="Resize sidebar" line="vertical" lineColor="bg-hover" />
          </>
        )}
        <Panel id="main" className="flex min-w-0 flex-col bg-bg">
          {panels.main}
        </Panel>
        {panels.right && rightPanel && (
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

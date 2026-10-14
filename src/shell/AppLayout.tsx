import { useEffect, useRef, useState, type ReactNode } from "react";
import { Group, Panel } from "react-resizable-panels";
import { ConnectionDialog } from "../features/connections/ConnectionDialog";
import { SqlEditor } from "../features/editor/SqlEditor";
import { HistoryPalette } from "../features/history/HistoryPalette";
import { ResultsPane } from "../features/results/ResultsPane";
import { SettingsPage } from "../features/settings/SettingsScreen";
import { SettingsSearchPalette } from "../features/settings/SettingsSearchPalette";
import { SearchPalette } from "../features/sidebar/SearchPalette";
import { Sidebar } from "../features/sidebar/Sidebar";
import { useWorkspace, type Screen } from "../state/workspace";
import { Kbd } from "../ui/primitives";
import { START_COMMANDS, commandForKey, shortcutLabel } from "./commands";
import { Overlays } from "./Overlays";
import { PixelColumn } from "./PixelColumn";
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
              className="flex h-8 w-full items-center justify-between rounded-md px-2.5 text-ui-13.5 text-muted hover:bg-hover hover:text-fg"
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

function MainArea() {
  const active = useWorkspace((s) => (s.active ? s.tabs[s.active] : undefined));
  const showResults = useWorkspace((s) => s.layout.results);
  const resultsHeight = useWorkspace((s) => s.layout.resultsHeight);
  const resultsPx = useRef<number | null>(null);
  // Saved on release only: a store update mid-drag re-renders the Group and the library drops the drag.
  const saveResultsHeight = () => {
    const { layout, setLayout } = useWorkspace.getState();
    if (resultsPx.current !== null && resultsPx.current !== layout.resultsHeight) setLayout({ resultsHeight: resultsPx.current });
  };

  return (
    <Group orientation="vertical" className="min-h-0 flex-1" onLayoutChanged={saveResultsHeight}>
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
            onResize={(size) => {
              resultsPx.current = Math.round(size.inPixels);
            }}
          >
            <ResultsPane tabId={active?.id ?? null} />
          </Panel>
        </>
      )}
    </Group>
  );
}

type ScreenPanels = { main: ReactNode; right: boolean };

function screenPanels(screen: Screen, hosted: HostedWindow | null): ScreenPanels {
  switch (screen.kind) {
    case "workspace":
      return {
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
        main: <SettingsPage hosted={hosted} screen={screen} />,
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
  const rightPanel = useWorkspace((s) => s.layout.rightPanel);
  const panels = screenPanels(screen, hosted);

  return (
    <div className="relative flex h-full">
      {hosted?.chrome === "custom" && <ResizeEdges hosted={hosted} />}
      {sidebar && (
        <PixelColumn column="sidebar">
          <Sidebar hosted={hosted} />
        </PixelColumn>
      )}
      <div data-testid="main" className="flex min-w-80 flex-1 flex-col bg-bg">
        {panels.main}
      </div>
      {panels.right && rightPanel && (
        <PixelColumn column="right">
          <RightPanel hosted={hosted} />
        </PixelColumn>
      )}
      <SearchPalette />
      <SettingsSearchPalette />
      <HistoryPalette />
      <ConnectionDialog />
      <Overlays />
    </div>
  );
}

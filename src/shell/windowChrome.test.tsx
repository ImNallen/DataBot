import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Sidebar } from "../features/sidebar/Sidebar";
import { ResizeEdges, WindowControlButtons } from "./WindowChrome";
import { TopBar } from "./TopBar";
import { appTitleAlign, hostedWindow, windowControlOrder, windowControlSide, type HostedWindow } from "./windowChrome";

function fakeHost(side: HostedWindow["side"]): HostedWindow {
  return {
    side,
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    maximized: async () => false,
    onResize: async () => () => {},
    startResize: async () => {},
  };
}

it("keeps DataBot centered on macOS and pins it to the left on Windows and Linux", () => {
  expect(appTitleAlign("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe("center");
  expect(appTitleAlign("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")).toBe("start");
  expect(appTitleAlign("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36")).toBe("start");

  const mac = renderToStaticMarkup(<Sidebar titleAlign="center" />);
  expect(mac).toContain("DataBot");
  expect(mac).toContain('data-align="center"');
  expect(mac).toContain("justify-center");

  const linux = renderToStaticMarkup(<Sidebar titleAlign="start" />);
  expect(linux).toContain("DataBot");
  expect(linux).toContain('data-align="start"');
  expect(linux).toContain("justify-start");
  expect(linux).not.toContain("justify-center");
});

it("puts window buttons on the left on macOS and on the right elsewhere", () => {
  expect(windowControlSide("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe("left");
  expect(windowControlSide("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36")).toBe("right");
  expect(windowControlSide("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")).toBe("right");
});

it("orders buttons the way that side of the window does", () => {
  expect(windowControlOrder("left")).toEqual(["close", "minimize", "maximize"]);
  expect(windowControlOrder("right")).toEqual(["minimize", "maximize", "close"]);
});

it("has no hosted window in the browser", () => {
  expect(hostedWindow("Mozilla/5.0 (X11; Linux x86_64)")).toBeNull();
});

it("draws minimize, maximize, and close, with restore once the window is maximized", () => {
  const restored = renderToStaticMarkup(<WindowControlButtons hosted={fakeHost("right")} maximized={false} />);
  expect(restored.match(/data-testid="window-(?:minimize|maximize|close)"/g)).toEqual([
    'data-testid="window-minimize"',
    'data-testid="window-maximize"',
    'data-testid="window-close"',
  ]);
  expect(restored).toContain('aria-label="Maximize"');
  expect(restored).toContain("hover:bg-danger");

  const maximized = renderToStaticMarkup(<WindowControlButtons hosted={fakeHost("left")} maximized={true} />);
  expect(maximized.match(/data-testid="window-(?:minimize|maximize|close)"/g)).toEqual([
    'data-testid="window-close"',
    'data-testid="window-minimize"',
    'data-testid="window-maximize"',
  ]);
  expect(maximized).toContain('aria-label="Restore"');
});

it("gives the frameless window a resize edge on every side and corner", () => {
  const html = renderToStaticMarkup(<ResizeEdges hosted={fakeHost("right")} />);
  expect(html.match(/data-testid="window-resize-[A-Za-z]+"/g)).toEqual([
    'data-testid="window-resize-North"',
    'data-testid="window-resize-South"',
    'data-testid="window-resize-West"',
    'data-testid="window-resize-East"',
    'data-testid="window-resize-NorthWest"',
    'data-testid="window-resize-NorthEast"',
    'data-testid="window-resize-SouthWest"',
    'data-testid="window-resize-SouthEast"',
  ]);
});

it("keeps the toolbar draggable and hides window buttons outside Tauri", () => {
  const html = renderToStaticMarkup(<TopBar hosted={null} />);
  expect(html).toContain('data-tauri-drag-region="deep"');
  expect(html).not.toContain('data-testid="window-controls"');

  const hosted = renderToStaticMarkup(<TopBar hosted={fakeHost("right")} />);
  expect(hosted).toContain('data-testid="window-controls"');
  expect(hosted.indexOf('data-testid="toggle-right-panel"')).toBeLessThan(hosted.indexOf('data-testid="window-controls"'));
});

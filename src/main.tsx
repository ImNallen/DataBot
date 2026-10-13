import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";

import { isTauri } from "@tauri-apps/api/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { boot } from "./boot";
import { AppLayout } from "./shell/AppLayout";

async function start() {
  if (import.meta.env.DEV && !isTauri()) {
    const { installBridgeShim } = await import("./dev/bridgeShim");
    installBridgeShim();
  }
  const root = document.getElementById("root");
  if (!root) throw new Error("index.html is missing #root");
  const reactRoot = createRoot(root);
  try {
    await boot();
    reactRoot.render(
      <StrictMode>
        <AppLayout />
      </StrictMode>,
    );
  } catch (e) {
    reactRoot.render(
      <div data-testid="boot-status" className="grid h-full place-items-center text-dim">
        Engine unreachable: {String(e)}
      </div>,
    );
  }
}

void start();

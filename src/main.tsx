import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";

import { isTauri } from "@tauri-apps/api/core";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { commands } from "./ipc/bindings";

function Shell() {
  const [status, setStatus] = useState("Starting engine…");

  useEffect(() => {
    commands.appBoot().then(
      (boot) => setStatus(`Engine ready · ${boot.connections.length} connections`),
      (e: unknown) => setStatus(`Engine unreachable: ${String(e)}`),
    );
  }, []);

  return (
    <div className="grid h-full grid-rows-[40px_1fr_24px]">
      <header className="flex items-center border-b border-border bg-panel px-3 font-medium">DataBot</header>
      <main className="grid min-h-0 grid-cols-[260px_1fr]">
        <aside className="border-r border-border bg-panel" />
        <section className="p-4 font-mono text-muted">-- SQL editor</section>
      </main>
      <footer data-testid="boot-status" className="flex items-center border-t border-border bg-panel px-3 text-xs text-muted">
        {status}
      </footer>
    </div>
  );
}

async function start() {
  if (import.meta.env.DEV && !isTauri()) {
    const { installBridgeShim } = await import("./dev/bridgeShim");
    installBridgeShim();
  }
  const root = document.getElementById("root");
  if (!root) throw new Error("index.html is missing #root");
  createRoot(root).render(
    <StrictMode>
      <Shell />
    </StrictMode>,
  );
}

void start();

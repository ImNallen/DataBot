import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Tauri's devUrl and the dev-bridge CORS allowlist both expect exactly this port.
  server: { port: 5173, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] } },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  test: { include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
});

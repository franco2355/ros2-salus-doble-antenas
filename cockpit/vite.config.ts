import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    ...(host
      ? { hmr: { protocol: "ws", host, port: 5174 } }
      : undefined)
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_ENV_DEBUG
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setupTests.ts"],
    globals: true,
    css: true,
    exclude: ["src/test-extension/**", "**/node_modules/**", "**/dist/**"]
  }
});

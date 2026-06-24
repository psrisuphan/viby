import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

/// <reference types="vitest" />

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const browserTest = process.env.VIBY_BROWSER_TEST === "1";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react({
      babel: {
        plugins: ["babel-plugin-react-compiler"],
      },
    }),
  ],
  resolve: browserTest
    ? {
        alias: {
          "@tauri-apps/api/core": fileURLToPath(
            new URL("./src/browser-shims/core.ts", import.meta.url),
          ),
          "@tauri-apps/api/event": fileURLToPath(
            new URL("./src/browser-shims/event.ts", import.meta.url),
          ),
          "@tauri-apps/api/window": fileURLToPath(
            new URL("./src/browser-shims/window.ts", import.meta.url),
          ),
          "@tauri-apps/api/app": fileURLToPath(
            new URL("./src/browser-shims/app.ts", import.meta.url),
          ),
        },
      }
    : undefined,

  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));

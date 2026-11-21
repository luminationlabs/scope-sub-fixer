import { defineConfig } from "vite";

// Tauri expects a fixed port and does its own reloading of the Rust side.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  build: { target: "safari15", outDir: "dist", emptyOutDir: true },
});

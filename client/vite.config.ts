import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @pixeloffice/shared is consumed as raw TypeScript source (its package "main"
// points at src/index.ts). Excluding it from dep pre-bundling lets Vite compile
// it together with the client so we always read the single source of truth.
//
// React is here ONLY for the Excalidraw whiteboard island (the rest of the
// client is vanilla TS + Phaser). The island is dynamically imported, so React
// + Excalidraw land in a separate lazy chunk and never bloat first paint.
export default defineConfig({
  plugins: [react()],
  server: {
    // Listen on 0.0.0.0 so `npm run dev` is reachable over the LAN (prints a
    // Network: http://<lan-ip>:5173 URL). Teammates open that URL and the
    // client dials the API on the SAME host at :2567 (see net/connection.ts).
    host: true,
    port: 5173,
  },
  // Excalidraw reads process.env.IS_PREACT to pick its build; Vite strips
  // process.env by default, so define the one flag it needs. es2022 is required
  // by Excalidraw's bundle (top-level await / modern syntax).
  define: {
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  build: {
    target: "es2022",
  },
  optimizeDeps: {
    exclude: ["@pixeloffice/shared"],
  },
});

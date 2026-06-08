import { defineConfig } from "vite";

// @pixeloffice/shared is consumed as raw TypeScript source (its package "main"
// points at src/index.ts). Excluding it from dep pre-bundling lets Vite compile
// it together with the client so we always read the single source of truth.
export default defineConfig({
  server: {
    // Listen on 0.0.0.0 so `npm run dev` is reachable over the LAN (prints a
    // Network: http://<lan-ip>:5173 URL). Teammates open that URL and the
    // client dials the API on the SAME host at :2567 (see net/connection.ts).
    host: true,
    port: 5173,
  },
  optimizeDeps: {
    exclude: ["@pixeloffice/shared"],
  },
});

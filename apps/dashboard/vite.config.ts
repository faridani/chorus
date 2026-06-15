import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// During dev, proxy API + WebSocket to the daemon. In prod the daemon serves
// the built SPA directly, so these proxies are dev-only.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:7878",
      "/ws": { target: "ws://127.0.0.1:7878", ws: true },
    },
  },
  build: { outDir: "dist" },
});

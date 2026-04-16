import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/api/messenger/ws": {
        target: "ws://localhost:3000",
        ws: true,
      },
    },
  },
});

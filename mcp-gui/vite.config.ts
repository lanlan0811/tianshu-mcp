import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Tauri 期望前端产物落在固定目录，且开发服务器端口固定（见 src-tauri/tauri.conf.json 的 devUrl）。
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // Tauri 的 devUrl 固定为 1420；端口被占用时直接失败，避免静默换端口导致宿主连不上。
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 800,
    target: "es2022",
  },
});
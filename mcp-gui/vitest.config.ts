import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// 只测**纯逻辑**（解析 / 筛选 / 分块 / i18n 完整性 / mock 数据出口）：
// 一律跑在 node 环境，不依赖 DOM 与 Tauri 运行时，因此不需要 jsdom / 组件测试栈。
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    globals: true,
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
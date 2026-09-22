import { defineConfig } from "vitest/config";

// 双 project 拆分（vitest 4 test.projects）：
// - unit：test/unit/**；文件间隔离，避免 discovery 的 exec mock 污染真实 Git 基线检查；
// - integration：真实子进程组杀 / 端口语义（test/integration/** + test/protocol/**），保持串行。
// 注意：vitest 4 的 project 不继承根级 test 选项，公共项需逐 project 显式声明。
// npm test（vitest run）一次跑全部 project。
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          globals: true,
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 60_000,
          isolate: true,
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts", "test/protocol/**/*.test.ts"],
          globals: true,
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 60_000,
          pool: "forks",
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
    ],
  },
});

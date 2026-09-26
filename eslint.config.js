import eslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".tianshu-mcp/**",
      ".tmp-check/**",
      "analysis-tools/**",
      // mcp-gui 是独立桌面应用（issue #25），有自己的 package.json / eslint.config.js，
      // 不参与根工程 `eslint . --max-warnings 0`（否则无匹配配置的新文件会报错）。
      "mcp-gui/**",
    ],
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": eslint,
    },
    rules: {
      ...eslint.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
      "no-control-regex": "off",
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      // stdout 由 MCP transport 独占：禁止运行时代码直接写 stdout（issue #1）。
      // 启动失败仍允许 console.error（stderr）；开发脚本与测试 fixture 不受此限。
      "no-console": ["error", { allow: ["error"] }],
    },
  },
  {
    // pre-server CLI 子命令：在创建 MCP server 之前返回，stdout 未被 transport 占用，
    // 面向人的输出正是 console.log 的正当用途（与「运行时代码禁写 stdout」的红线不冲突）。
    files: ["src/visual/cli.ts", "src/config/cli.ts"],
    rules: { "no-console": "off" },
  },
  prettier,
];

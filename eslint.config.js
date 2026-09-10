import eslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: ["dist/**", "node_modules/**", ".tianshu-mcp/**", "analysis-tools/**"],
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
  prettier,
];

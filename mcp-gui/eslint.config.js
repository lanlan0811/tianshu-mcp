import pluginVue from "eslint-plugin-vue";
import tseslint from "typescript-eslint";

// mcp-gui 的独立 flat config（不继承根工程配置；根工程已 ignore mcp-gui/**）。
export default [
  {
    ignores: ["dist/**", "node_modules/**", "src-tauri/**", "coverage/**"],
  },
  ...tseslint.configs.recommended,
  // 只用 essential（纠错规则）：recommended 额外包含大量纯排版偏好规则
  // （max-attributes-per-line / singleline-html-element-content-newline 等），
  // 与 Prettier 职责重叠，会在 `--max-warnings 0` 下产生噪声。
  ...pluginVue.configs["flat/essential"],
  {
    files: ["**/*.vue"],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
  },
  {
    // 构建脚本（纯 Node，无打包步骤）：显式声明运行时全局，避免对 .mjs 误报 no-undef。
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // 组件名多为领域名词（TaskList / LogViewer），不强制多词。
      "vue/multi-word-component-names": "off",
    },
  },
];
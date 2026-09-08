# 贡献指南（CONTRIBUTING）

感谢你有兴趣为 `tianshu-mcp` 做贡献。本文说明开发环境、工程规范与提交流程。

英文版：[CONTRIBUTING.en.md](CONTRIBUTING.en.md)

---

## 1. 前置要求

| 项 | 要求 |
|---|---|
| Node.js | ≥ 20（CI 覆盖 20 / 22） |
| 包管理器 | npm（仓库含 `package-lock.json`） |
| 操作系统 | Windows / macOS / Linux（CI 三平台矩阵） |
| Git | 用于基线分析相关功能与提交 |

## 2. 本地开发

```bash
git clone https://github.com/lanlan0811/tianshu-mcp.git
cd tianshu-mcp
npm ci                # 按 lockfile 安装
npm run build         # sync-version + tsc → dist/
npm test              # vitest（单元 + 集成 + 协议）
```

常用脚本：

| 命令 | 作用 |
|---|---|
| `npm run build` | 同步版本号（`scripts/sync-version.mjs`）并编译到 `dist/` |
| `npm run dev` | 用 `tsx` 直接运行 `src/index.ts`（stdio 服务） |
| `npm test` | 全量测试（vitest run） |
| `npm run test:watch` | 监听模式 |
| `npm run typecheck` | `tsc --noEmit` 类型检查 |
| `npm run lint` | ESLint，`--max-warnings 0`（零容忍） |
| `npm run format` | Prettier 格式化 `src` 与 `test` |
| `npm run pack:check` | `npm pack --dry-run`，确认发布内容 |

## 3. 提交前必须通过（与 CI 一致）

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

CI 额外校验两条，请本地也注意：

1. **构建后工作树无意外改动**：`npm run build` 会重写 `src/version.generated.ts`；
   改版本号时该文件必须与 `package.json` 一并提交，否则 CI 的「No unexpected tracked diff after build」会失败。
2. **tarball 内容**：`npm pack` 后必须包含 `dist/index.js`、`skills/tianshu-mcp/SKILL.md`、
   `README.md`、`README.en.md`、`LICENSE`（以及 `assets/`）。

## 4. 工程规范

- **语言**：代码注释、日志、错误文案、文档均为中文；对外文档需**中英双语、分两个文件**
  （`X.md` 与 `X.en.md`）。
- **不写硬编码**：机器路径、用户名、端口等一律走 profile / 配置或占位符（如 `{LOCALAPPDATA}`），
  代码只提供探测规则与默认值。
- **双系统兼容**：涉及路径/进程/信号的地方必须同时考虑 Windows 与 POSIX（CI 三平台矩阵会验证）。
- **图标用 SVG**：禁止使用 emoji 作为图标。
- **零 lint 警告**：`npm run lint` 为 `--max-warnings 0`。
- **测试**：新功能/缺陷修复应带测试；纯函数优先做单元测试，涉及编排/协议走集成或协议测试。
- **外部输入**：一律经 zod 校验（`src/config/schema.ts`）。

## 5. 代码结构导览

```text
src/
├── index.ts              入口（stdio）
├── server.ts             组装：配置/日志/管理器/引擎/注册表/工具注册/技能自检安装
├── config/               zod schema 与数据目录读写（热加载）
├── mcp/                  工具注册表、handler、上下文、结果格式化（文本 + meta 块）
├── tasks/                任务状态机、队列、并发闸、事件流落盘
├── loop/                 单任务编排（返修循环）与修复计划生成
├── agents/               adapter 抽象、registry、spawn 封装、内置 profiles
│   └── traework/         GUI 驱动（CDP 客户端 / 选择器 / 启动器 / UI / 受限 computer-use）
├── verify/               验收引擎（命令检查 + 代码分析 + git 基线 + 报告）
└── util/                 日志、路径、文件、超时等
```

测试分层：

| 层级 | 位置 | 说明 |
|---|---|---|
| 单元 | `test/unit/` | 纯函数与组件逻辑 |
| 集成 | `test/integration/` | stub-agent 三剧本、TraeWork 假 CDP 端到端 |
| 协议 | `test/protocol/` | 官方 SDK stdio/in-memory 客户端断言工具面与返回格式 |
| 真机探针 | `scripts/probe-traework.mjs` | 需真实 TraeWork，**不入 CI** |

## 6. 提交与分支规范

- **只在 `master` 分支提交**，不创建其他分支。
- **提交信息用中文**，建议 `类型: 摘要` 形式，类型可选：`feat` / `fix` / `docs` / `chore` / `test` / `refactor`。
- **一个功能一次提交**，提交前确保门禁全绿。
- 推送目标：`github`（主仓库）与 `gitee`（镜像仓库）双推。

```bash
git add .
git commit -m "feat: 新增 xxx"
git push github master
git push gitee master
```

## 7. 版本与发布

- 版本号遵循语义化版本；发版时：
  1. 修改 `package.json` 的 `version`；
  2. `npm run build` 同步 `src/version.generated.ts`；
  3. 提交并推送两个仓库；
  4. 打 tag（如 `v0.1.5`）并推送到两个仓库 → 触发 `Release` workflow 校验
     `tag == package.json == tarball` 并创建 GitHub Release（draft，需人工发布）；
  5. `npm publish --registry=https://registry.npmjs.org --access public`。
- 变更需同步登记到 [CHANGELOG.md](CHANGELOG.md)（英文版同步更新 `CHANGELOG.en.md`）。

## 8. 新增一个外部 AI-Agent

绝大多数情况**无需改代码**，只需在数据目录 `agent-profiles.json` 加一段 profile：

1. 参考 [docs/agent-profiles.md](docs/agent-profiles.md) 的字段说明；
2. CLI 类：配 `command` / `argsTemplate` / `promptMode` / `cwd`；
   GUI 类：配 `driver: "gui"` 与 `gui` 段；
3. 若输出解析有特殊语义（如非 0 退出码但成功），再实现一个 `AgentAdapter` 并在 registry 注册；
4. 用 `get_profiles` 自检可执行探测，跑一次真实任务验收。

## 9. 报告问题

- Bug / 功能请求：用仓库 Issue 模板（`.github/ISSUE_TEMPLATE/`）。
- 安全漏洞：**不要**开公开 Issue，按 [SECURITY.md](SECURITY.md) 的渠道私密报告。

## 10. 行为准则

参与本项目即表示同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

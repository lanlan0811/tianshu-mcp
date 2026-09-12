# tianshu-mcp v0.3.1 发布说明

v0.3.1 是一次**文档与发布自动化收口**版本：无源码行为变更，不涉及任何 adapter / 验收引擎改动。

核心是两件事：

1. **技能自检安装文档（`skills/tianshu-mcp/`）全面重写**，与 v0.3.0 实际工具面逐项核对对齐；
2. **修复 v0.3.0 tag 发布时实测暴露的 Release 自动化问题**，并把 Gitee 发行版纳入自动化。

## 技能文档重写（对齐 v0.3.0 工具面）

宿主 agent（如天枢）加载的 `SKILL.md` / `usage-examples.md` 此前残留了 codex 仍是无头 CLI 的旧描述，
本次逐项对照 `src/mcp/tools.ts`、`src/config/schema.ts`、`src/agents/builtin.ts` 等实现重写：

- 修正 `codex`：ChatGPT 桌面端 GUI adapter（MSIX + COM 激活 + CDP），**`model` 必填**（如 `GPT-5.6 Sol`），
  可选 `reasoningLevel` / `planDoc` / `designSystem`，不支持 `mode`；快速上手示例同步修正
  （旧示例按文档调用会直接报「Codex 必须指定 model」）。
- 补齐 `run_task` 的 `context` 参数语义（以【上下文与约束】拼进初始指令）与
  task/context 路径引用发送前校验说明；修正 `autoFixRounds` 默认值优先级
  （调用参数 > codex 5 / zcode 2 > server 默认 0）。
- 补齐 `list_tasks`（此前完全未写入文档）、`query_task(tailLines)`、`get_task_report(round)`、
  `verify_task`（`extraChecks` / `checksMode` / `baselineRef`）与验收命令四级优先级。
- 补充 `needs_user` 四种等待类型与 meta 块 `needsUserKind` / `pendingQuestion` / `errorType` /
  `reportRound` / `verificationSource` 等字段解读，宿主可据此决定「回答问题」还是「确认已处理」。
- 审批清单补上 `continue_task`（写操作需审批）；示例中 emoji 状态标记改为文字（PASS / 告警）。

## 发布自动化修复

- **Release 正文双语合成**：正文取自 `docs/release-v<版本>.md` 与 `.en.md`，
  文档内相对链接改写为该 tag 的绝对链接；缺文档时工作流明确报错，不再产出只有 Full Changelog 的空壳正文。
- **Full Changelog 修复**：经 `git describe` 解析上一 tag，生成 `compare/<prev>...<tag>` 比较链接。
- **CI 链接修正**：正文 `CI` 链接解析同 SHA 的 CI 运行，避免误指 Release 自身运行。
- **Gitee 发行版自动化**：`release.yml` 末尾经 Gitee OpenAPI 幂等创建/更新镜像发行版
  （`scripts/gitee-release.mjs`，需仓库 Secret `GITEE_TOKEN`；未配置时明确提示并跳过）。
- `CHANGELOG` 双语版底部补齐 `[0.1.10]` / `[0.2.0]` / `[0.3.0]` / `[0.3.1]` 比较链接。

## 升级说明

- `npm install -g tianshu-mcp` 或 `npx tianshu-mcp` 升级后，技能文档会在 server 启动时自检安装到
  `~/.rivet/skills/tianshu-mcp/`（旧版自动备份为 `.bak-<时间戳>`）；**新会话生效**，已开启的会话仍使用旧文本。
- 无配置迁移、无 API 变更；从 v0.3.0 升级零操作成本。

## 发布门禁

typecheck、lint、全量测试、build、严格 stdio、npm pack 内容及干净消费者安装必须全部通过；
版本在 `package.json`、lockfile、生成文件、tag 与 Release 之间保持一致。

# tianshu-mcp v0.5.7 发布说明

[English](release-v0.5.7.en.md)

**文档版本**：把编排技能文档（`skills/tianshu-mcp/`）按当前代码逐项重写。**本版本无运行时行为变更**，升级无需改动调用方；改动只影响天枢读到的技能说明。

## 技能文档重写（`SKILL.md` + `usage-examples.md`）

逐项核对了 `src/mcp/tools.ts`、`src/config/schema.ts`、`src/tasks/task.ts`、`src/tasks/task-manager.ts`、`src/loop/fix-loop.ts`、`src/mcp/formatter.ts`、`src/agents/builtin.ts` 与五个 GUI 适配器的实际实现，修正并补齐以下内容：

- **参数兼容矩阵**：`projectPath` / `model` / `modelSource` / `reasoningLevel` / `mode` / `planDoc` / `designSystem` / `allowCreateProject` / `continue_task` 九个维度 × 五个内置 agent。明确「传错即报错、不会静默忽略」的边界，例如别名 `极高`/`最大`/`关闭思考` 仅 qoder 接受。
- **默认值优先级**：新增 `autoVerify`（server 默认**开启**）、`autoFixRounds`（codex 5 / zcode 2 / kimicode 2 / qoder 3 / traework 落 server 默认 0）、`taskTimeoutMs` 的完整取值顺序表。
- **Kimi Code 档位修正**：取值域为 `低/low`、`高/high`、`max`、`on`、`off`——**刻意不含 `中`/`medium`**；档位集合按界面实际渲染标签校验，非官方模型不传时强制 `on`，界面不存在的档位在发送前报错。
- **qoder 章节补全**：`modelSource` 消歧规则、模型管理档位保存后重开回读、全局偏好不还原、发送与答题检查点导致的不重发、自动与手动返修均先落计划再回发全文、macOS 禁止派发；新增多题续答的 JSON 对象示例（键为界面完整问题文字）。
- **`needsUserKind` × agent × `continue_task` 行为矩阵**：六类等待 × codex/zcode/kimicode/qoder，写清哪类只作「已处理」确认、哪类会补发完整任务书、哪类把内容发到原会话，以及锚点丢失一律 fail-closed。
- **`agentEndReason` → 终态映射**：`task_timeout` / `idle_timeout` / `cdp_disconnected` 与其余硬失败的落点差异；补 `project_not_registered`、`unsupported_platform`、`qoder_error`（含 18 个具体错误码）等此前缺失的条目。
- **meta 字段全表补齐**：`qoderSessionId`、`actualModel`、`actualReasoningLevel`、`modelSource`、`guiStop`；说明 `reasoningLevel` 是入参不回显、codex 的实际等级只能看面板。
- **验收用法讲清差异**：`verify_task` 的三种用法（任务复验只更新结论字段、独立 `projectPath` 的 `baselineRef` 只能是 git ref、手动验收单独分配报告轮次），以及 `prepare_visual_baseline` / `approve_visual_baseline` 的必填参数约束（UUID 候选人 + 64 位十六进制摘要 + 批准说明）。
- **结构分工**：主文件讲方法论与决策边界，子文件只给可直接复制的形状；清理重复与过时段落。

## 技能分发与生效

- 技能随包分发（`files` 含 `skills`），server 启动时按内容 hash 幂等同步到 `~/.rivet/skills/tianshu-mcp/`；内容变化才覆盖，旧版备份为 `.bak-<时间戳>`。
- **新会话生效**，没有热加载：已开启的会话仍使用旧文本，请开新会话或重启宿主。
- 技能目录只有中文版（沿用历史约定），双语发布说明见本文件与 [English](release-v0.5.7.en.md)。

## 门禁与证据

- 全量回归 **826 passed / 12 skipped**（Windows 10 x64，Node 24.18.0；78 个测试文件通过 + 3 个真实浏览器文件按设计 skip），类型检查、lint、构建与 6 项严格 stdio 检查全通过。
- 技能格式门禁（`test/unit/skill-format.test.ts`）覆盖 frontmatter 约束与子文件结构要求。
- 本版本为 **PATCH**：无运行时行为变更，既有调用方签名、报告字段与错误码语义**保持向后兼容**。

相关文档：[项目 README](../README.md)｜[CHANGELOG](../CHANGELOG.md)｜[技能文档 SKILL.md](../skills/tianshu-mcp/SKILL.md)｜[使用示例](../skills/tianshu-mcp/usage-examples.md)

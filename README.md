<div align="center">

# tianshu-mcp

**天枢 × AI-Agent 编排 MCP server**

由天枢（Tianshu）当作标准 MCP server 接入，调度外部 AI-Agent CLI（Codex / Zcode / TraeWork，可横向扩展）完成 **项目开发 → 验收 → 失败返修 → 再验收** 的闭环。

TypeScript · Node.js ≥ 20 · `@modelcontextprotocol/sdk`（stdio）

</div>

---

## 这是什么

天枢的角色是总指挥；本 MCP server 是**调度 + 执行面 + 客观验收仪**；外部 AI-Agent CLI（Codex 等）是执行开发的"工人"。

- **8 个 MCP 工具**：`run_task / query_task / list_tasks / get_task_report / cancel_task / verify_task / rework_task / get_profiles`。
- **异步契约**：`run_task` 秒回 `taskId`，长任务用 `query_task` 轮询（长任务不卡 `tools/call`）。
- **客观验收**：自动命令检查（typecheck/lint/test/build，缺则跳过 + 技术栈推导）+ 程序化代码分析（变更清单/diffstat/TODO·debugger·密钥形态等可疑标记），全部相对 **git 基线**，不自动 commit/stash。
- **失败返修闭环**：自动返修（`autoFixRounds`）+ 手动 `rework_task`；轮次用尽 → `needs_attention` 等天枢裁决。
- **调度纪律**：每项目串行队列 + 全局并发上限（默认 2，可配）。
- **不碰密钥**：各 agent 用自己的登录态；本 server 不保存/转发任何 API key。
- **可扩展**：新 agent = 一个 profile（数据）+（如需）一个 adapter 文件，零改编排核心。

## 快速开始

```bash
npm install
npm run build        # → dist/
npm test             # 25 项测试：单元 + stub-agent 三剧本集成 + 协议
```

配置为天枢 MCP server（本地开发模式）：

```jsonc
{
  "mcp": {
    "servers": {
      "tianshu-mcp": {
        "command": "node",
        "args": ["<仓库绝对路径>/dist/index.js"],
        "env": { "TIANSHU_MCP_HOME": "<仓库绝对路径>/.tianshu-mcp" }
      }
    }
  }
}
```

新开会话后，工具面出现 `mcp__tianshu-mcp__run_task` 等 8 个工具。用 stub 预演（不碰真实登录态）→ 切 codex 跑真实任务：

```text
run_task(projectPath=D:/xxx/my-app, task=「…任务书…」, agentId=codex, autoVerify=true, autoFixRounds=2)
  → taskId → query_task(taskId) 轮询 → succeeded / failed / needs_attention → get_task_report 读报告
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/tianshu-integration.md](docs/tianshu-integration.md) | 天枢 config.json 两种接入模式、UI/API 操作、冒烟步骤、FAQ |
| [docs/agent-profiles.md](docs/agent-profiles.md) | agent profiles 字段说明 + 真实机器样例（codex M2 定稿） |
| [docs/adapter-matrix.md](docs/adapter-matrix.md) | 各 Agent 能力调研矩阵（Codex/Zcode/TraeWork/扩展位） |
| [docs/m2-smoke-record.md](docs/m2-smoke-record.md) | M2 真实 codex 冒烟记录（run_task→verify_task 通过 + 缺陷修复） |
| [docs/m2-rework-record.md](docs/m2-rework-record.md) | M2 codex rework 闭环记录（失败→rework_task→再验收，含物证） |
| [docs/acceptance-config.md](docs/acceptance-config.md) | 项目级 `.tianshu-mcp/acceptance.json` 验收配置规范 |
| [skills/tianshu-mcp/](skills/tianshu-mcp/SKILL.md) | 教天枢编排本 MCP 的技能（含使用示例） |

## 里程碑状态

- **M1 — 核心引擎 + stub-agent 全链路** ✅
  - 8 工具、TaskManager 状态机/队列/并发闸/cancel(kill tree)/事件流落盘
  - 验收引擎（git 基线/diff、默认集推导、命令 runner、代码分析、report.md/json）
  - fix-loop 自动返修 + needs_attention；技能自检安装（已在本机真实 `~/.rivet/skills` 验证）
  - stub-agent 三剧本（good/fix-on-first/never）集成测试 + 协议测试，**32/32 绿**
- **M2 — 真实 Codex CLI 冒烟 + rework 闭环** ✅（2026-09-07）
  - 真实 `codex exec` 跑通 `run_task → query_task → verify_task`（[m2-smoke-record.md](docs/m2-smoke-record.md)）
  - 真实 **失败→rework_task→再验收 succeeded** 闭环（[m2-rework-record.md](docs/m2-rework-record.md)，物证 `docs/m2-evidence/`）
  - 修复冒烟暴露的 3 个真实缺陷（Windows npm 垫片 / spawn 日志竞态崩溃 / codex flags 互斥）并各加回归测试
  - Zcode headless 入口（Z1）仍待产品侧确认
- **工程/CI** ✅（2026-09-07）
  - GitHub Actions 实测：`CI`（Node 20/22 矩阵）与 `Release`（tag v0.1.0 触发）均绿（提交 d91aea8 起）
  - 技能自检安装已在本机真实 `~/.rivet/skills/tianshu-mcp` 验证生效且幂等
  - npm 包名 `tianshu-mcp` 在 npmjs 可用（未占用）
- **M3 — TraeWork 调研 + 全套交付** 🔜（TraeWork 状态见 adapter-matrix；npm publish 需 npmjs token；天枢真实会话技能触发实测 需 GUI 会话）

## 推荐用法（给天枢的提示语）

> "在项目 D:\xxx 用 codex 实现『任务』。先跑 run_task(autoVerify:true, autoFixRounds:2)，完成后用 query_task 看结果；若报告显示 needs_attention，把 get_task_report 的失败项摘要作为 feedback 调 rework_task 再验一轮；全部通过后向我汇报 changedFiles 与 diffstat。"

## 许可

[MIT](LICENSE)

<div align="center">

# tianshu-mcp

**天枢 × AI-Agent 编排 MCP server**

由天枢（Tianshu）当作标准 MCP server 接入，调度外部 AI-Agent（Codex CLI；TraeWork/TRAE SOLO CN 经 CDP 驱动桌面 UI）完成 **项目开发 → 验收 → 失败返修 → 再验收** 的闭环（架构可横向扩展）。

TypeScript · Node.js ≥ 20 · `@modelcontextprotocol/sdk`（stdio）

</div>

---

## 这是什么

天枢的角色是总指挥；本 MCP server 是**调度 + 执行面 + 客观验收仪**；外部 AI-Agent（Codex CLI、TraeWork GUI）是执行开发的"工人"。

- **8 个 MCP 工具**：`run_task / query_task / list_tasks / get_task_report / cancel_task / verify_task / rework_task / get_profiles`。
- **异步契约**：`run_task` 秒回 `taskId`，长任务用 `query_task` 轮询（长任务不卡 `tools/call`）。
- **客观验收**：自动命令检查（typecheck/lint/test/build，缺则跳过 + 技术栈推导）+ 程序化代码分析（变更清单/diffstat/TODO·debugger·密钥形态等可疑标记），全部相对 **git 基线**，不自动 commit/stash。
- **失败返修闭环**：自动返修（`autoFixRounds`）+ 手动 `rework_task`；验收失败时自动生成修复计划文件并回填给 agent；轮次用尽 → `needs_attention` 等天枢裁决。
- **两种执行面**：`driver: "spawn"` 走外部 CLI 子进程（Codex）；`driver: "gui"` 走桌面 UI 自动化（TraeWork 经 CDP 驱动，可选 `model` 指定模型）。
- **调度纪律**：每项目串行队列 + 全局并发上限（默认 2，可配）。
- **不碰密钥**：各 agent 用自己的登录态；本 server 不保存/转发任何 API key。
- **可扩展**：新 agent = 一个 profile（数据）+（如需）一个 adapter 文件，零改编排核心。

## 快速开始

```bash
npm install
npm run build        # → dist/
npm test             # 150 项测试：单元 + stub-agent 三剧本集成 + 协议 + TraeWork 假 CDP + 取消/超时/基线/参数/配置回归
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
| [docs/traework-cdp.md](docs/traework-cdp.md) | TraeWork GUI 驱动（CDP）：原理、配置、选择器、安全红线、踩坑记录、验证记录 |
| [docs/m2-smoke-record.md](docs/m2-smoke-record.md) | M2 真实 codex 冒烟记录（run_task→verify_task 通过 + 缺陷修复） |
| [docs/m2-rework-record.md](docs/m2-rework-record.md) | M2 codex rework 闭环记录（失败→rework_task→再验收，含物证） |
| [docs/host-integration-record.md](docs/host-integration-record.md) | 天枢宿主真实接入实测（DoD #6：2 servers / 10 tools） |
| [docs/dod7-release-record.md](docs/dod7-release-record.md) | DoD #7：npm 发布 tianshu-mcp@0.1.1 + npx 拉起连通记录 |
| [docs/acceptance-config.md](docs/acceptance-config.md) | 项目级 `.tianshu-mcp/acceptance.json` 验收配置规范 |
| English docs | [acceptance-config.en.md](docs/acceptance-config.en.md) · [tianshu-integration.en.md](docs/tianshu-integration.en.md) · [agent-profiles.en.md](docs/agent-profiles.en.md) · [adapter-matrix.en.md](docs/adapter-matrix.en.md) · [traework-cdp.en.md](docs/traework-cdp.en.md) |
| [skills/tianshu-mcp/](skills/tianshu-mcp/SKILL.md) | 教天枢编排本 MCP 的技能（含使用示例） |

## 里程碑状态

- **M1 — 核心引擎 + stub-agent 全链路** ✅
  - 8 工具、TaskManager 状态机/队列/并发闸/cancel(kill tree)/事件流落盘
  - 验收引擎（git 基线/diff、默认集推导、命令 runner、代码分析、report.md/json）
  - fix-loop 自动返修 + needs_attention；技能自检安装（已在本机真实 `~/.rivet/skills` 验证）
  - stub-agent 三剧本（good/fix-on-first/never）集成测试 + 协议测试，**72/72 绿**（含 R1–R5/S1–S6 取消/超时/基线/参数/配置回归）
- **M2 — 真实 Codex CLI 冒烟 + rework 闭环** ✅（2026-09-07）
  - 真实 `codex exec` 跑通 `run_task → query_task → verify_task`（[m2-smoke-record.md](docs/m2-smoke-record.md)）
  - 真实 **失败→rework_task→再验收 succeeded** 闭环（[m2-rework-record.md](docs/m2-rework-record.md)，物证 `docs/m2-evidence/`）
  - 修复冒烟暴露的 3 个真实缺陷（Windows npm 垫片 / spawn 日志竞态崩溃 / codex flags 互斥）并各加回归测试
  - Zcode 无头接口（Z1）实测定论：ZCode 桌面无随包 headless CLI → unsupported
- **工程/CI** ✅（2026-09-07）
  - GitHub Actions 实测：`CI`（Node 20/22 矩阵）与 `Release`（tag v0.1.0 触发）均绿（提交 d91aea8/2a9ac82 起）
  - 技能自检安装已在本机真实 `~/.rivet/skills/tianshu-mcp` 验证生效且幂等
  - npm 包名 `tianshu-mcp` 在 npmjs 可用（未占用）
- **天枢宿主真实接入（DoD #6）** ✅（2026-09-07，[host-integration-record.md](docs/host-integration-record.md)）
  - 在真实 `D:\Tianshu` 桌面宿主 `mcp.servers` 配置 §11.1 本地模式 → sidecar `MCP: 2 servers connected, 10 tools`（含本 server 8 工具），spawn 子进程并 stdio 连通
  - 实测暴露并修复技能安装源路径 bug（fileURLToPath，提交 55cf2d0）
- **M3 — TraeWork 调研 + 全套交付** ✅（2026-09-07 T1 定论 + **npm 已发布**）
  - T1 定论：本机 TRAE SOLO CN v1.107.1 实测 **无无头可编程 agent 接口**（仅 VS Code 家族 CLI；见 [adapter-matrix.md](docs/adapter-matrix.md)）
  - **npm 已发布**：`tianshu-mcp@0.1.1`（`npm view` 可查，`npx -y tianshu-mcp` 拉起 8 工具连通，见 [dod7-release-record.md](docs/dod7-release-record.md)）
  - GUI 聊天会话内实际调用工具（DoD #8 最后一环）需用户开天枢新会话（宿主连通与 8 工具注册已就位）
- **M4 — TraeWork GUI 驱动接入（CDP）** ✅（2026-09-08，见 [traework-cdp.md](docs/traework-cdp.md)）
  - 结论更正：无头 CLI 确实不存在，但 `--remote-debugging-port` 可驱动聊天 UI；`traework` 改为 `driver=gui` / `status=ready`
  - 能力：启动/复用实例 → 新建会话 → 绑定项目文件夹（下拉命中优先，未命中走受限 computer-use 原生对话框）→ 可选指定模型 → 任务书回读校验后发送 → 轮询到完成 → 自动验收 → 失败生成修复计划并同会话返修
  - 安全：默认复用用户实例、绝不按进程树强杀、终止前核对命令行；computer-use 仅允许 TraeWork 文件夹对话框
  - 真机验证：`run_task(agentId=traework, model=GLM-5.3, autoVerify=true)` 驱动 TraeWork 创建文件并验收通过；测试 72 → **150**

## 验收整改（R1–R8，2026-09-07；S1–S6，2026-09-08）

- **R1** ✅ 取消/中断状态机持久化：运行中取消 `cancel_requested → cancelled`（cancelReason/finishedAt/errorType 落盘）、重启可恢复、幂等、shutdown 有界等待。
- **R2** ✅ 调用级 `taskTimeoutMs` 覆盖生效（adapter 不再用 profile 覆盖）、POSIX 进程组 SIGTERM→SIGKILL、Windows taskkill /T /F，kill-tree 单实现。
- **R3** ✅ Git 基线参与差异计算：以 baseline.head 为边界，agent 提交不丢变更、脏工作区 hash 归因、porcelain 逐文件展开。
- **R4** ✅ 参数语义：`get_task_report(round=0)` 合法、手动验收分配新轮次不覆盖、`extraChecks` 追加 + `checksMode=replace`、`optional` 不影响 verdict、`baselineRef` 校验。
- **R5** ✅ 移除路径硬编码（`{LOCALAPPDATA}` 等占位符 + 平台标准候选），config/profile/projects 热加载。
- **R6** ✅ CI 矩阵 Windows/macOS/Linux × Node 20/22 全绿；Release 版本一致性校验；tarball 内容校验。
- **R7** ✅ 真实 Tianshu serve 会话实测（技能加载 + MCP 工具 + stub 任务闭环）；npm v0.1.2 发布 + npx 拉起连通。
- **R8** ✅ 文档同步 + 复验报告。

二次整改（按 `.codex/plans/2026-09-08-second-remediation-plan.md`）：
- **S1** ✅ 无理由取消稳定落 `cancelled`（新增 `cancelRequestedAt`/`abortSource` 独立字段，不依赖可选 reason）。
- **S2** ✅ 普通超时统一落 `failed(timeout)` + 一次 `timeout_killed` 事件，顺序固定。
- **S3** ✅ tracked 预脏净差异归因：staged/unstaged 未变文件不再误报为 agent 变更。
- **S4** ✅ `verify_task(taskId)` 持久化更新原任务元数据（`reportRound`/`verificationSource`/`latestVerificationVerdict`，保留 agentId）；MCP 版本单一来源（build 注入，服务端实测 version=0.1.2）。
- **S5** ✅ config/profiles/projects 热加载 last-known-good + 内容 sha256 失效检测（修复损坏 JSON 被当缺失重置的 bug）。
- **S6** ✅ CI/Release npm ci 重试修正（成功即停/3 次上限/attempt 计数）；Vitest v3 升级（audit 0 漏洞）；纯文本状态标记（emoji 扫描测试）。
- **S7/S8/S9** 真实完整证据与新版发布待最终闭环（详见 `.codex/review/`）。

## 推荐用法（给天枢的提示语）

> "在项目 D:\xxx 用 codex 实现『任务』。先跑 run_task(autoVerify:true, autoFixRounds:2)，完成后用 query_task 看结果；若报告显示 needs_attention，把 get_task_report 的失败项摘要作为 feedback 调 rework_task 再验一轮；全部通过后向我汇报 changedFiles 与 diffstat。"

## 许可

[MIT](LICENSE)

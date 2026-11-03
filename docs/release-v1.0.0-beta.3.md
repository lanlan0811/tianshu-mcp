# v1.0.0-beta.3 — 文档全量收口 + 零残留门禁

> **本计划（六版）的收官版本**：文档全量收口，并新增一个**常驻门禁**确保已移除的两个 agent
> （TraeWork / Qoder CN）不会以任何形式回流。
>
> 这是「移除 TraeWork 与 Qoder CN」六版计划的第 6 版。

**本版无行为变化。**

---

## 新增：零残留门禁

`scripts/check-removed-agents.mjs`（`npm run check:removed-agents`），接入 `.github/workflows/ci.yml`
的 `build-test` 作业：

| 区域 | 规则 |
|---|---|
| `src/` / `scripts/` / `package.json` / `.github/workflows/` | **零容忍**：出现 `traework` 或 `qoder`（**含注释**）即失败 |
| 历史发布说明 / CHANGELOG / HANDOFF / 迁移说明 / 0.9.10 显式验收用例 / `mcp-gui/` | **白名单**（逐条列名，不用宽泛前缀） |
| 其余任何命中 | **失败**（要求显式销账或改为中性表述） |

设计要点：白名单**逐条列名**而非宽泛前缀，且「既不在零容忍区也不在白名单」直接判失败——否则
一旦有人把这两个 agent 加回某个未覆盖的文件，门禁会静默放过。`tianshu-mcp-web/`（官网目录，
AGENTS.md 禁止修改）与本地工具目录（`.claude/` / `.rivet/` 等）显式跳过。

**负向自测**：临时往 `src/agents/cli.ts` 追加一行含 `traework` 的注释 → 门禁非 0 退出并点名该文件；
移除后恢复通过。

## 文档全量收口

- README 双文档 / ARCHITECTURE 双文档 / HANDOFF / CHANGELOG 双文档 / SKILL + usage-examples /
  `docs/adapter-matrix` 双文档 / `docs/agent-profiles` 双文档 / CONTRIBUTING / SECURITY：
  所有「**当前状态**」表述不再把两个已移除 agent 列为可用。
- **历史段落保留原样**：`docs/release-v*.md`、CHANGELOG 各版本条目、HANDOFF 的历史交接快照
  ——它们是当时的事实，改写等于篡改历史记录。

---

## 端到端真机验证

| # | 场景 | 期望 | 结果 |
|---|---|---|---|
| 1 | `query_info(type="profiles")` | 列出 codex / zcode / kimicode / opendesign / minimax / stub，**无** traework / qoder | ✅ |
| 2 | `run_task(agentId="traework", …)` | `agent_unresolved` 硬失败，不烧验收轮次 | ✅ |
| 3 | `run_task(agentId="qoder", …)` | 同上 | ✅ |
| 4 | codex 真机派发一轮 + 自动验收 | 通过（**核心回归**：共享 CDP 传输迁址后仍正常） | 需真机额度，见下 |
| 5 | zcode 真机派发一轮 | 通过 | 需真机额度，见下 |
| 6 | kimicode / opendesign / minimax 各一轮 | 通过 | 需真机额度，见下 |
| 7 | 数据目录放 `agentId:"qoder"` 的历史 `task.json`，`manage_task(action="rework")` | `failed(agent_unresolved)`，不误跑 | ✅ |
| 8 | 宿主传 `mode` / `modelSource` | 统一「已废弃」文案（**不是** zod 报错） | ✅ |

**关于 4–6**：真实派发需驱动本机桌面端（Codex / ZCode / Kimi Code / Open Design / MiniMax Code）
并消耗其额度，属计划中「若环境具备」的可选步骤。本版已验证的部分：本机 `query_info(type="profiles")`
对五个 agent 全部 `[PASS] 可用`（探测到真实安装），共享 CDP 传输与各 agent 的行为由全量测试覆盖。

---

## 验证

| 门 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 0 error |
| `npm run lint`（`--max-warnings 0`） | 0 warning |
| `npx vitest run test/unit test/integration test/protocol` | 全绿 |
| `npm run build && npm run check:stdio` | stdout 纯净 |
| `npm run check:removed-agents` | 通过（零容忍区 0 命中） |
| `npm run pack:check` | 清单符合预期 |

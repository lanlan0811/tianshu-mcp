# v0.6.6 — dryRun 干跑模式（先审后做）

> 关联 issue：[#21](https://github.com/lanlan0811/tianshu-mcp/issues/21)。详见 [dryRun 干跑模式](dry-run.md)。

## 背景

`run_task` 直接驱动 agent 修改源码，若 agent 理解偏差，可能产生大量需要回滚的改动。
调用方有时希望「先看方案、再决定是否真干」，此前不支持这种中间态。

## 新增

- **`run_task(dryRun=true)`**：agent 只做分析、规划，输出将要修改的文件清单与修改方案，
  **不实际改动源码**；验收引擎**只做静态分析**（引用文件是否存在、拟修改位置是否真实存在、
  是否存在明显逻辑冲突），跳过 typecheck / test / build / 视觉验收 / `requireChanges`。
- **计划契约**：约束要求 agent 把方案写成 `<project>/.tianshu-mcp/dry-run-plan.json`：

  ```jsonc
  { "summary": "一句话方案",
    "files": [ { "path": "src/foo.ts", "action": "modify", "reason": "为什么改",
                 "edits": [ { "line": 42, "symbol": "buildToken", "action": "怎么改" } ] } ] }
  ```

- **「先审后做」闭环**：dryRun 把结构化计划渲染为**项目内**方案文档
  `.tianshu-mcp/dry-run-plan-<taskId>.md`，`meta.dryRunPlanDoc` 给出项目相对路径，
  可直接作为后续正式 `run_task` 的 `planDoc` 传入。

## 静态检查项

| code | 级别 | 判定 |
|---|---|---|
| `path_outside_project` | error | 计划路径是绝对路径或含 `..` |
| `path_forbidden` | error | 计划路径落在 `.git/` 或 `node_modules/` |
| `conflicting_actions` | error | 同一路径被声明了互相矛盾的动作 |
| `dry_run_violation` | error | **零改动门禁**：排除 MCP 自有产物后仍有基线变更 |
| `file_already_exists` / `file_not_found` | warning | `create` 目标已存在 / `modify`·`delete` 目标不存在 |
| `edit_line_out_of_range` / `edit_location_missing` | warning | 行号越界 / symbol 在文件中找不到 |
| `file_unreadable` | warning | 文件存在但读不到 |
| `dry_run_artifacts_only` | warning | **仅** MCP 允许的产物有变更（不计为源码改动） |

## 关键设计决定

| 决定 | 理由 |
|---|---|
| 只读约束注入在 `makeBuildCtx()` | 全部 5 个适配器的提示词都拼 `ctx.context`，**一次改动覆盖全部适配器**；dryRun 是 round 0 首次派发，zcode/kimicode 的 `initialDispatch` 守卫不会吞掉它 |
| 独立引擎方法 `runDryRun()`，不在 `executeVerify` 里分支 | dryRun 产物是 `DryRunReport`（与 `VerifyReport` 口径不同）；并进同一条返回值就得引入联合类型或伪造一个 `VerifyReport`，既污染类型也让轮次账目变复杂 |
| 不消耗验收轮次 | 报告落 `dry-run-report-<round>.*`，不匹配 `^report-(\d+)\.(md\|json)$`，`nextReportRound()` 天然忽略 |
| **零改动门禁是核心证据** | 相对动工前基线求差、排除 MCP 自有产物；**不依赖计划写对** —— agent 完全不产出计划时这条仍然有效 |
| 判定 `needs_attention` 而非 `failed` | 方案有问题属**人工裁决**，不是可以自动返修的代码缺陷 |
| 不进入返修循环、忽略 `autoVerify` | dryRun 没有「失败的代码」可修；其语义是「先审」而非「验收」 |
| 无项目模式显式拒绝 | 没有可静态分析的文件树与基线；静默忽略会让调用方误以为在干跑 |
| 方案文档落在项目内 | `planDoc` 只能读项目文件，放任务数据目录 agent 够不到 |
| 计划缺失时降级但可见 | `planExtracted: false` + `fallbackReason`；降级为仅零改动门禁，报告与文案都标注「计划提取: 失败」 |

## 兼容性

- **`dryRun` 是新增可选参数、默认关闭**：不传时 `run_task` 行为与 v0.6.5 完全一致。
- 无工具契约、数据模型破坏性变更；MCP 注解不变。

## 如实披露

- **预演仍是一次真实的 agent 调用**：消耗外部 agent 的额度与时间；它省的是「错误改动需要回滚」的代价，
  不是「不调用 agent」。
- **不保证 agent 遵守只读约束**：靠任务书里的明确指令 + 事后零改动门禁。违反会被拦下并如实报告，
  但**已经发生的改动不会自动回滚**（MCP 从不自动 commit / stash / checkout）。
- **静态检查无法判断方案是否合理**：只能验证「文件存在、位置对得上、无明显矛盾」——那正是「先审」
  要人工做的事。
- **`planDoc` 的适配器差异**：目前只由 **Codex 与 Qoder CN** 的提示词构造消费；CLI 类 agent 与
  ZCode / Kimi Code / TraeWork **不读取**它。对这些 agent 需把方案路径写进 `task` 文本（文件在项目内，
  它们能读）。这正是把方案文档放在**项目内**而非任务数据目录的原因。

## 测试

- 新增 37 个用例（2 个文件）：
  - `test/unit/dry-run.test.ts`（29）：`parseDryRunPlan` 的合规 / 空 files / 未知 action / 绝对路径（POSIX 与
    Windows 盘符）/ `..` 穿越 / `.git` 与 `node_modules` / 非法行号；合规预演通过且无 error；计划文件与
    `planDoc` 允许清单不计为改动；仅产物变更时的非阻断提示；改源码 → `dry_run_violation` 阻断；计划缺失 /
    JSON 坏 / 结构非法三种降级路径且原因可见；计划缺失**且**改源码仍被门禁拦下；`create` 撞存在文件、
    `modify` 指向不存在文件、行号越界、symbol 缺失、动作矛盾各自产出正确 code 与 file/line；报告
    markdown / jsonable（`kind: "dry-run"`）/ 方案文档（含「尚未实施、不是验收通过证据」声明）/ 相对路径
    辅助函数。
  - `test/integration/dry-run.test.ts`（8）：合规预演 → `succeeded` 且 `git status` 里所有变更都落在
    `.tianshu-mcp/` 下（源码文件未被触碰）；`dry-run-report-0.*` 存在而 `report-0.*` 不存在（**不消耗轮次**
    且产物分离）；只读约束确实进入任务书（读 agent 日志断言「不得创建、修改或删除任何源文件」等文案）；
    违规预演 → `needs_attention` + `dry_run_violation`；默认关闭时走常规验收（产出 `report-0.md`）；dryRun
    忽略 `autoVerify`；无项目模式拒绝 `dryRun`；**「先审后做」闭环** —— dryRun 的 `dryRunPlanDoc` 指向真实
    存在的项目内方案文档，把它作为 `planDoc` 派发的正式任务被接受并成功。
  - `test/stub-agent/stub-agent.mjs` 新增 `dry-run-plan`（只写计划不改源码）与 `dry-run-edit`
    （写计划且偷改源码）两个剧本。
- 全量 `npm test`：**1110 passed / 12 skipped**（101 文件；v0.6.5 为 1073 passed / 12 skipped，净增 37）。
- 新增用例已按 v0.6.5 的 CI 教训处理：**不依赖本机安装任何 GUI agent**（无项目模式用例自行桩化 profile）。

## 真机记录

**待补（交付后执行）**：用 `scripts/probe-codex.mjs` 或 traework 探针跑一次真实 GUI 任务并加
`dryRun=true`，确认 agent 遵守只读约束（`git status` 无源码改动）且计划文件被正确解析、
方案文档可作为后续正式任务的 `planDoc` 复用，输出落 `docs/` 证据文件。
本版以单测 + 假 CDP/stub 集成测试为门禁（issue #21 的验收标准允许「有对应测试**或**真机证据」，
本版取前者；真机记录作为交付后待办写入 HANDOFF.md）。

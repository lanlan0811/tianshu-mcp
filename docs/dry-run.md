# dryRun 干跑模式（先审后做，issue #21）

英文版：[dry-run.en.md](dry-run.en.md)

`run_task` 默认直接驱动 agent 修改源码；理解偏差可能产生大量需要回滚的改动。`dryRun` 提供
「先看方案、再决定是否真干」的中间态。

```jsonc
run_task(projectPath="D:/proj", task="把登录接口改成 JWT", dryRun=true)
```

## 一、dryRun 下发生什么

| 阶段 | 行为 |
|---|---|
| 派发 | 任务书照常下发，但 `ctx.context` 里会并入一段**只读预演约束**（见下），要求 agent 只分析规划、不得改动源码，并把方案写成机器可读的计划文件 |
| 验收 | **只做静态分析**：解析计划文件 → 逐条核对引用文件是否存在、拟改位置是否存在、是否有明显逻辑冲突；**跳过** typecheck / test / build / 视觉验收 / `requireChanges` |
| 终态 | 静态分析无阻断项 → `succeeded`；有阻断项 → **`needs_attention`**（方案有问题属人工裁决，不是可以自动返修的代码缺陷） |
| 返修 | **不进入**自动返修循环 |
| 轮次 | **不消耗**验收轮次——报告文件名是 `dry-run-report-<round>.*`，不匹配 `^report-(\d+)\.(md\|json)$` |

`dryRun` 刻意**忽略 `autoVerify`**：它的语义是「先审」而不是「验收」。
`dryRun` **需要 `projectPath`**：无项目模式没有可静态分析的文件树与基线，显式拒绝而不是退化成普通任务。

## 二、agent 必须产出的计划文件

约束要求 agent 把方案写到**项目根的 `.tianshu-mcp/dry-run-plan.json`**：

```jsonc
{
  "summary": "一句话方案",
  "files": [
    {
      "path": "src/foo.ts",          // 必须是项目相对路径
      "action": "modify",            // create | modify | delete
      "reason": "为什么要改",         // 可选
      "edits": [                      // 可选，但写了就要与文件真实内容对得上
        { "line": 42, "symbol": "buildToken", "action": "改为签发 JWT" }
      ]
    }
  ]
}
```

这是一份**契约**：MCP 会按它逐条静态核对，所以「随便写」会体现为 warning 甚至 error。
路径必须是项目相对路径，且**拒绝**绝对路径、`..` 穿越、`.git` 与 `node_modules`。

## 三、静态检查项

| finding code | 级别 | 判定 |
|---|---|---|
| `path_outside_project` | error | 计划路径是绝对路径或含 `..` |
| `path_forbidden` | error | 计划路径落在 `.git/` 或 `node_modules/` |
| `conflicting_actions` | error | 同一路径被声明了互相矛盾的动作（如同时 `delete` 与 `modify`） |
| `dry_run_violation` | error | **零改动门禁**：排除 MCP 自有产物后，相对动工前基线仍存在变更 |
| `file_already_exists` | warning | `create` 的目标已存在（确认是覆盖还是应改为 `modify`） |
| `file_not_found` | warning | `modify` / `delete` 的目标不存在 |
| `edit_line_out_of_range` | warning | `edits[].line` 超出文件实际行数 |
| `edit_location_missing` | warning | `edits[].symbol` 在文件里找不到 |
| `file_unreadable` | warning | 文件存在但读不到 |
| `dry_run_artifacts_only` | warning | **只有** MCP 允许的产物有变更（不计为源码改动，不阻断） |

**零改动门禁是核心证据**：它不依赖计划是否写对——即使 agent 完全不产出计划，只要动了源码就会被
`dry_run_violation` 拦下。这是「dryRun 下源码零改动」这条验收标准的机器可检形式。

## 四、计划缺失时：降级但可见

agent 不遵守约束（没写计划、写了非 JSON、结构不合法）时，**不会静默通过**：

- `planExtracted: false` + `fallbackReason` 写明原因；
- 检查降级为**只做零改动门禁**（这一条与计划无关，仍然有效）；
- 报告与文案都会如实标注「计划提取: 失败」，不会假装检查过。

## 五、产物与「先审后做」闭环

| 产物 | 路径 | 说明 |
|---|---|---|
| 静态分析报告 | `tasks/<taskId>/dry-run-report-<round>.md` / `.json` | 与常规 `report-<round>.*` **分开**：两者结论口径不同（静态分析 vs 真实命令验收）。`meta.dryRunReportFiles` 给出路径；json 里带 `kind: "dry-run"` 标记 |
| 方案文档 | **项目内** `.tianshu-mcp/dry-run-plan-<taskId>.md` | 由结构化计划渲染，`meta.dryRunPlanDoc` 给出**项目相对路径** |

闭环用法（两步）：

```jsonc
// ① 先审
run_task(projectPath="D:/proj", task="把登录接口改成 JWT", dryRun=true)
// → succeeded，meta.dryRunPlanDoc = ".tianshu-mcp/dry-run-plan-tsk_xxx.md"

// ② 后做：把上面那个路径原样作为 planDoc 传入
run_task(projectPath="D:/proj", task="按方案实施", planDoc=".tianshu-mcp/dry-run-plan-tsk_xxx.md")
```

**关于 `planDoc` 的适配器差异（如实说明）**：`planDoc` 目前由 **Codex 与 Qoder CN** 的提示词构造消费；
**CLI 类 agent 与 ZCode / Kimi Code / TraeWork 不读取它**。对这些 agent 请把方案路径**写进 `task` 文本**
（例如「按 `.tianshu-mcp/dry-run-plan-tsk_xxx.md` 实施」）——文件本身落在项目内，它们能读。
把方案文档放在**项目内**而不是任务数据目录，正是为了让所有 agent 都能读到它。

## 六、已知边界

- **预演仍是一次真实的 agent 调用**：会消耗外部 agent 的额度与时间。它省的是「错误改动需要回滚」的
  代价，不是「不调用 agent」。
- **不保证 agent 遵守只读约束**：靠的是任务书里的明确指令 + 事后的零改动门禁。违反会被拦下并如实报告，
  但**已经发生的改动不会自动回滚**（MCP 从不自动 commit / stash / checkout）。
- **计划质量仍取决于 agent**：静态检查只能验证「文件存在、位置对得上、无明显矛盾」，
  无法判断方案本身是否合理——那正是「先审」要人工做的事。

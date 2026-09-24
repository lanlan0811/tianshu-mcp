# v0.6.4 — 结构化修复指令（repairDirectives）

> 关联 issue：[#19](https://github.com/lanlan0811/tianshu-mcp/issues/19)。详见 [结构化修复指令](repair-directives.md)。

## 背景

验收失败时会自动生成修复计划文件并回填给 agent，但报告偏向**完整叙述**——agent 需自行从整份报告里
定位具体问题（哪一行类型不匹配、哪个文件有 TODO、哪个文件变更行数异常），既增加推理开销，
也提高理解偏差导致返修失败的概率。

## 新增

- **结构化修复指令**：把失败原因解析为可直接执行的动作。

  | 来源 | 匹配方式 | 产出 |
  |---|---|---|
  | `typecheck` | 失败检查项 name/argv 命中 `typecheck\|tsc\|--noEmit\|mypy\|pyright` | 每条 tsc 报错（pretty `file(l,c): error TSxxxx` 与 plain `file:l:c - error TSxxxx` 两式）→ `{file, line, issue, action}`；绝对路径归一化为项目相对 posix 路径；同处报错去重 |
  | `diffstat` | 报告的 `analysis` 段 | 超大单文件改动（>500 行）、被改动的锁文件各一条（带 `file`）；TODO/FIXME、console.log/debugger、疑似密钥的行级计数各一条（**不带** `file`，因为只做计数、无稳定行号） |

- **`rework_task` 新增可选 `repairHint`**：自由字符串（上限 4000 字符），在下一轮任务书里以
  `【结构化修复提示】` 块渲染，并**排在 `feedback` 之前** —— 先精确定位，再给整段说明。

## 消费路径（四处）

| 载体 | 内容 |
|---|---|
| `report-<round>.json` | `repairDirectives` 完整字段（**仅失败轮次**；持久化，供跨重启与手动返修路径重读） |
| `report-<round>.md` | `## 结构化修复指令` 小节 |
| 返修计划（`rework-*.md` / `codex-fix-r*.md`） | `## 2.5 结构化修复指令` 小节，插在第 2 节与第 3 节之间 |
| 返修消息 | `【结构化修复指令（摘要，最多 10 条）】` 块；提取失败时**不**在此处加噪声 |

## 关键设计决定

| 决定 | 理由 |
|---|---|
| 匹配按「检查项 name / argv 启发式」 | 仓库内**没有** per-verifier 模块（typecheck/test/build 都是通用 argv 命令检查），没有现成的检查器类型可用 |
| **不做** test 类提取 | 测试框架输出没有稳定的文件/行号，强行解析会产出**错误**定位，比不给更糟；一律走回退 |
| 提取器**永不抛错**，单个 source 异常被吞掉并记入 `fallbackReason` | 一个提取器写坏了不该让返修彻底失去上下文 |
| 提取不到时**显式回退**（写明原因 + 要求回到完整失败输出） | 让「提取失败」成为可观测事实，而不是静默降级留空段 |
| 只在失败轮次提取 | 通过的轮次没有要修的东西，提取只会徒增报告体积 |
| 指令落 `report.json` | 手动返修路径（fix-loop 的 qoder 分支）会重读该文件，且需跨 server 重启存活 |
| 行级信号不伪造 `file` | `signals.ts` 只做计数，没有稳定文件与行号 |
| `LOCKFILE_PATTERN` 改为导出、两处共用 | 分析告警与提取器共守一份锁文件清单，避免漂移 |

**已知限制（有意接受）**：`CheckResult.outputTail` 被截断到最后 4000 字符（`runner.ts`），
大型 TypeScript 项目的类型错误总量可能远超此数，因此**只能提取到尾部错误**，其余靠回退兜底。
不为提取而放大报告体积是刻意的取舍。

## 兼容性

- **无工具契约、数据模型或 MCP 注解变更**。
- `repairDirectives` 是报告内的新增可选字段：旧读方按缺省忽略即可；通过的轮次不产出该字段。
- `repairHint` 不传时 `rework_task` 行为与 v0.6.3 完全一致。

## 测试

- 新增 35 个用例（3 个文件）：
  - `test/unit/repair-directives.test.ts`（15）：tsc pretty / plain 两式解析；mypy 等启发式选中；绝对路径归一化（项目内转相对、项目外原样保留）；同处报错去重；已通过/已跳过/非类型检查项不参与；diffstat 五类指令（含未跟踪锁文件）；行级信号不带 `file`；并集语义；test 类失败回退；单个 source 抛错被吞掉且其余继续；全部抛错时返回带错误的 `fallbackReason`。
  - `test/unit/repair-plan-directives.test.ts`（16）：`renderDirectiveSection` 有/无指令两分支与「无具体文件」形态；`renderDirectiveLines` 10 条截断；通用与 Codex 两套返修计划的 2.5 节**位置**（在第 2 与第 3 节之间）与回退文案；`reportToJsonable` 有/无字段（向后兼容：不带时不产生该键）与回退原因落盘；`reportToMd` 两分支；端到端「失败报告 → 提取 → 计划文档」连贯性。
  - `test/integration/rework-repair-hint.test.ts`（3 组共 4 例）：`repairHint` 确实进入下一轮任务书且**排在 feedback 之前**（读 stub agent 落盘的任务书断言）；不传时任务书里没有该块；超 4000 字符被协议层拒绝；自动返修生成的 `rework-<id>-r0.md` 含 2.5 节（可用或带原因的回退段，不允许静默留空）且 `report-0.json` 已持久化 `repairDirectives`。
- 全量 `npm test`：**1037 passed / 12 skipped**（96 文件；v0.6.3 为 1002 passed / 12 skipped，净增 35）。
- `check:stdio`：dist 与 src 均 **8/8**（未新增工具，场景数不变）。

## 真机记录

**待补（交付后执行）**：用 `scripts/probe-codex.mjs` 跑一次真实项目，构造一个必然 typecheck 失败的任务，
确认 `rework-*.md` / `codex-fix-r*.md` 的 2.5 节给出正确的 `文件:行` 与动作，并留存**前后对比**的
返修记录（issue #19 验收标准要求「至少一份前后对比的真机返修记录」）。本版以单测 + 集成测试为门禁。

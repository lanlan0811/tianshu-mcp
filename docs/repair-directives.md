# 结构化修复指令（issue #19）

英文版：[repair-directives.en.md](repair-directives.en.md)

## 一、为什么需要它

验收失败时，MCP 会生成返修计划并回填给 agent。但返修报告偏向**完整叙述**——agent 需要自己
从整份报告里定位「哪一行类型不匹配、哪个文件有 TODO、哪个文件改动行数异常」。这既增加它的
推理开销，也提高了理解偏差导致返修失败的概率。

结构化的修复指令把失败原因直接解析为**可执行动作**：

```
- `src/foo.ts:42` — TS2322: Type 'string' is not assignable to type 'number'. → 修正该处类型错误（依据 TS2322 提示）
- `package-lock.json` — 锁文件被修改 → 确认依赖变更是有意的；若非有意请还原该锁文件
- （无具体文件） — 新增/变更行含 TODO/FIXME/HACK 共 3 处 → 实现或移除这些待办标记
```

每条指令形如 `{ file?, line?, issue, action, source }`：`issue` 说明**是什么**，`action` 说明**做什么**。

## 二、提取器：两个内置来源

提取发生在验收引擎内部（`src/verify/directives.ts` 的 `extractRepairDirectives()`），
**只在验收失败的轮次**执行——通过的轮次没有要修的东西，不提取以免徒增报告体积。

| 来源 | 输入 | 产出 |
|---|---|---|
| `typecheck` | 失败检查项中 name/argv 命中 `typecheck\|tsc\|--noEmit\|mypy\|pyright` 的 `outputTail` | 每条 `file(line,col): error TSxxxx` / `file:line:col - error TSxxxx` 解析为一条指令（绝对路径归一化为项目相对 posix 路径；同一处报错去重） |
| `diffstat` | 报告的 `analysis` 段 | 超大单文件改动（>500 行）、被改动的锁文件（`package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` / `Cargo.lock` / `go.sum` / `Pipfile.lock` / `poetry.lock` / `composer.lock`）各一条；以及行级信号统计（TODO/FIXME、console.log/debugger、疑似密钥形态）各一条 |

> **为什么没有「test 检查器」来源**：测试类失败的命令行输出没有稳定的文件/行号（不同测试框架
> 格式各异），强行解析会产出**错误**的定位，比不给更糟。这类失败一律走回退路径（见下）。
>
> `diffstat` 的行级信号（TODO / 调试输出 / 疑似密钥）只做**计数**，没有稳定的文件与行号，
> 因此对应指令**不带** `file` 字段 —— 不伪造定位。

## 三、回退：提取不到就退回整份报告

**这是本能力的鲁棒性底线**：提取器永不抛错，失败以数据形式表达在 `fallbackReason` 里。

```jsonc
// report-<round>.json
"repairDirectives": {
  "items": [],
  "sources": [],
  "fallbackReason": "本轮失败原因无法解析为可直接执行的指令（如测试类失败无稳定的文件/行号）"
}
```

渲染方（返修计划、返修消息）据此**显式声明不可用**，而不是静默留空：

```markdown
## 2.5 结构化修复指令（不可用，回退完整报告）

原因：本轮失败原因无法解析为可直接执行的指令（如测试类失败无稳定的文件/行号）

> 请**阅读第 2 节的完整失败输出**自行定位问题，不要依赖本节的省略形式。
```

单个来源抛错时会被吞掉、记入 `fallbackReason`，**其余来源继续工作**——一个提取器写坏了不该
让返修彻底失去上下文。

## 四、三步消费路径

| 载体 | 内容 |
|---|---|
| `report-<round>.json` | `repairDirectives` 完整字段（持久化：跨 server 重启、以及手动返修路径会重读该文件） |
| `report-<round>.md` | `## 结构化修复指令` 小节（每条带来源标注） |
| 返修计划文档（`rework-<id>-r<n>.md` / Codex 的 `codex-fix-r<n>.md`） | `## 2.5 结构化修复指令` 小节，插在第 2 节（失败项）与第 3 节（通过项）之间 |
| 返修消息（发给 agent 的正文） | `【结构化修复指令（摘要，最多 10 条）】` 块；提取失败时**不**在此处加噪声（计划文档的 2.5 节已如实交代） |

## 五、`rework_task` 的 `repairHint`

除了引擎自动提取，调用方也可以自带一条提示：

```jsonc
rework_task(taskId, feedback="请按提示修复后重跑验收。",
            repairHint="src/done.txt:1 — 内容应为 PASS 而非 TODO → 把该行改为 PASS")
```

- 自由字符串，**上限 4000 字符**（超出由协议层拒绝）。
- 在下一轮任务书里以 `【结构化修复提示】` 块渲染，并**排在 `feedback` 之前** —— 先给精确定位，再给整段说明。
- 不传时行为与既有版本完全一致。

## 六、已知限制（如实披露）

- **`outputTail` 截断**：检查项的输出尾部被截断到最后 **4000 字符**（`src/verify/runner.ts`）。
  大型 TypeScript 项目的类型错误总量可能远超此数，因此**只能提取到尾部错误**；提取不到的部分
  不会凭空出现——请回看完整报告。这是有意接受的限制：与其为了提取而放大报告体积，
  不如让回退路径承担兜底。
- **路径归一化**：相对项目根的路径原样保留；绝对路径若落在项目内则转为相对，若落在项目外
  则**原样保留**（不做无法验证的裁剪）。
- **指令是「待办清单」不是「已修复证明」**：它只描述要做什么，修没修好仍由下一轮验收判定。

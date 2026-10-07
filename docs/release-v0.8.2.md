# v0.8.2 — Codex 模型触发器回读不再把等级条当成型号（issue #34）

> 详见 [CHANGELOG](../CHANGELOG.md#082---2026-10-07)。

## 本版主题：让「读到一个模型名」真的只读模型名

Codex 模型触发器的回读此前读的是**整个按钮的 `innerText`**。真机 `26.930.4958.0` 实测该按钮内除模型名外
还有**整条思考等级条**——档位轮播的 9 层全部在 DOM 里（`无/极低/轻度/中/高/极高/Max/Ultra/持续`），
仅当前档 `opacity:1`，其余 `opacity:0` **但 `display:block`**，故 `innerText` 会把整条一并读出：

```text
6 Luna
中
无 极低 轻度 中 高 极高 Max Ultra 持续
```

旧实现的解析正则要求文本**以等级词结尾**，而实际以「持续」结尾 → 不匹配 → `if (!m) return { model: flat }`
把**整串**当型号 → `exactUiName(model, "6 Luna")` 恒假 → 走换模型分支 → 三轮后判 `model_mismatch`。

**影响面是「全部带 `model` 的 Codex 派发」**：失败发生在发送任务书之前，因此 `autoFixRounds`
形同虚设——任务根本进不到返修环节。issue 报告在 `26.917.9434` / `26.917.8451` 两版复现，本机
`26.930.4958.0` 复测**同样复现**。

## 修复：读结构，不读整串

正则方案要**枚举全部档位词**（`无/极低/轻度/…/Max/Ultra/持续`），产品每加一档就再破一次；
而且它无法区分「型号名里本身含档位词」与「混入的档位条」。故改为读**结构**——读到的是当前值本身，
与档位数量解耦：

| 优先级 | 来源 | 真机证据 |
|---|---|---|
| ① `attrs` | `[data-codex-intelligence-trigger]` 的 `data-selected-reasoning-effort` + 其内 `[class*=ModelPickerTriggerModelText]` | 实测 `medium` |
| ② `nodes` | 模型名节点 + `[class*=ModelPickerTriggerEffortLabel] .sr-only` | 实测 `.sr-only` 文本 `中` |
| ③ `innerText` | 整串 → `parseTriggerValue` 切分（老版式 / 类名漂移兜底） | 兼容旧版式 |

**`matches()` 判据一个字未改** —— 修的是喂给它的数据，不是判据本身。这条边界很重要：
症状（`model_mismatch`）出现在 `run.ts`，根因在读取层（`cdp.ts` 把三个语义当成一个）与解析层
（`model.ts` 的契约过窄），修复也就落在那两处。

## 配套契约

- **两条档位来源不一致时以属性为准**，并 `warn` 如实回报（不静默选其一）。
- **三来源全空 = 「本次未读到」**，`resolveTriggerReadback` 返回 `{ model: "" }`，调用方
  `waitStableTrigger` 继续等待 —— **不得**据此判 `model_mismatch`（页面渲染中途的正常现象）。
- **稳定判据改用解析后的模型名**：原先比较原始文本，而档位条轮播动画会让它**永不稳定**。
- **`xhigh` 明确不猜**：`NormalizedLevel` 只有 low/medium/high 三档，
  `levelFromTriggerToken("xhigh")` 返回 `undefined`。

## 顺带取证：滑块档位随版本变化

真机 `26.930.4958.0` 的思考强度滑块为 **4 档**（`aria-valuemin=0 / aria-valuemax=3`），
`data-selected-reasoning-effort` 实测 `0=low / 1=medium / 2=high / 3=xhigh`；
而 `run.ts` 注释里的「5 档 / max=4」是 `26.903` 版式。**`LEVEL_SLIDER_STOP` 的 `high=2` 在新版式下
依然成立**，实现未改，仅修正过期注释。

## 验证

| 项目 | 结果 |
|---|---|
| 真机复验（生产实现，Codex `26.930.4958.0`） | `modelTriggerReadback()` → `{model:"6 Luna", levelToken:"medium", source:"attrs"}`，模型名与面板一致 |
| 修复前对照 | 同一按钮 `innerText` 为 `6 Luna 中 无 极低 轻度 中 高 极高 Max Ultra 持续` → 整串被当型号 |
| 新增单测 | 10 条（真机串兜底切分 / 结构化优先 / 双来源不一致取权威 / 全空不误判 / `xhigh` 不猜） |
| 新增端到端用例 | 1 条（模拟真机污染形态，仅剩 `innerText` 兜底时仍不误判） |
| 反转自检 | 回滚 `parseTriggerValue` → 6 条新用例变红；恢复 → 全绿（证明测试有辨别力） |
| 全量 | **1621 passed / 12 skipped**（131 文件）；`mcp-gui` 172 passed |
| 门禁 | `tsc` / `lint` / `check:stdio` 全绿 |

## 已知限制

- **档位词集合随版本变化**：issue 报告串以「最高」结尾，本机实测为「Max」。这是选择「读结构」的直接理由。
- **结构化读取依赖类名基名**（哈希后缀会变），与仓内既有全部 Codex 选择器同一约定；漂移时可用
  `gui.selectors` 热修复，`probe-codex.mjs` 新增的结构化探测项可作漂移监测。
- 「型号名随版本漂移」（`5.6 Terra` / `6 Luna` 等）是产品的正常行为，适配器 fail-closed + 回显候选的
  既有设计未变。

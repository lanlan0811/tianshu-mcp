# tianshu-mcp v0.9.1

**发布日期**：2026-10-08
**类型**：缺陷修复（**无破坏性变更**）
**英文版**：release-v0.9.1.en.md

---

## 一句话

在真实 TraeWork 桌面端（Code 模式 + `DeepSeek-V4.1-Flash`）跑通完整闭环后，修复 5 个缺陷。
其中两条是**结论与事实相反**级别——**排队提醒被误报为「任务完成」**（假成功）、
**取消路径完全失效**（假失败）。另新增 TraeWork 真机冒烟脚本。

**本版无破坏性变更、工具面不变（仍 8 个工具），升级无需改调用方。**

---

## 为什么值得单独发一版

这两个缺陷在真机之前**从未暴露**，因为它们只在特定真实条件下触发：

| 缺陷 | 触发条件 | 后果 |
|---|---|---|
| 排队提醒误报完成 | **免费用户高峰期**（模型请求量高，进入排队） | 拿到了「succeeded」，但任务**根本没开始执行** |
| 取消路径失效 | 每次取消 | 点不到停止按钮，GUI 里任务继续跑，只得如实标「未确认停止」 |

对编排型调用方（把 `run_task` 当异步任务用、依赖终态决策）来说，这两类都会导致**基于错误前提的后续动作**。

---

## 修复清单

### 1. 排队提醒被误报为「任务完成」（假成功）

**现象**：免费用户高峰期派单进入排队，TraeWork 显示

```
排队提醒
当前模型请求量较高，你目前排在 1064 位。升级会员，可在高峰期优先响应，
或尝试其他模型、切换 Auto 模式继续任务。
```

**根因（两个条件叠加）**：

1. 该气泡**带「由 AI 生成」footer** —— 正是适配器的完成标志；
2. 排队时 `stopVisible` / `tailLoading` **均为 false** —— 权威运行信号不命中。

于是轮询判定直接落到 `finished` 分支 → 上报 `succeeded`，**把「你排在 1064 位」当交付结果返回**。

**处置**：

- 新增排队识别，判定**优先于**完成标志。判别式取位次短语「排(在\|队) N 位」——
  正文里正常提及「排队」二字不会被误判（有专门测试守着）。
- 排队按**暂时等待**处理：继续轮询、周期性上报位次；**不占用「运行证据=」前缀**
  （该前缀是「agent 已开工」的语义契约，排队恰是尚未开工，占用会让调用方误判）。
- 超时终态文案点明「期间一直处于排队（最后位次 N）——任务尚未开始执行，建议换模型、错峰重派或升级会员」，
  与「任务跑了但失败」区分开。

**真机回放证据**（同一份真实 DOM + 真实 liveness 探针）：

```
修复前: judgePoll = finished   ← 假成功
修复后: judgePoll = queue      ← 位次 1064 正确提取
```

### 2. 取消时点击停止按钮失败

`click()` 原实现先 `element.click()`、抛错才回退坐标点击。但 `stopButton` 命中的是**图标元素**
（`.chat-input-v2-send-button-stop-icon`），这类元素**没有 `click()` 方法** ——
`TypeError: e.click is not a function` 直接冒泡，**回退分支根本不可达**。

改为**坐标点击优先、DOM click 兜底**（与 kimicode 适配器一致），DOM 分支加 `typeof` 守卫且异常不冒泡。

### 3. 取消时 CDP 已被自己断开

取消分支写成 `return abortResult()` 而非 `return await abortResult()`。

JS 语义下 `return <promise>` 会**立即执行外层 `finally`**（含 `cdp.disconnect()`），
不等 async 函数体完成 —— 点停止按钮时连接已被本函数的 finally 切断，报
`CDP_UNAVAILABLE: 连接已断开: 客户端主动断开`。

栈追踪证据：

```
at TraeworkCdpClient.disconnect
at runTraeworkTask            ← run.js finally 块
at async TraeworkGuiAdapter.run
at async TaskOrchestrator.run
```

对照：kimicode / minimax / opendesign 均写 `return await abortResult()`，**唯独 traework 漏了 `await`**。

**该缺陷同时解释了为何两次真机跑都报 `guiStop={clicked:false,idle:false}`** ——
不是停止按钮点不动，而是连接已被自己断掉。

### 4. `lastRunSignal` 恒为 undefined

进度 note 写「运行信号：」，而编排器（`fix-loop`）用 `/运行证据=([^；]+)/` 提取 ——
**六个 GUI 适配器里唯独 traework 用了别的措辞**。

该字段是 `query_task` 的**对外文档化字段**，也是调用方判断「agent 是否真在生成」的依据；
它恒为 undefined 直接导致 smoke 脚本的取消触发条件（`lastRunSignal === "stop_button"`）**永不成立**
—— 实测第一次跑取消，任务跑完了都没取消成功。

修正为「…；运行证据=\<值\>；…」。注意值后**必须紧跟「；」**：正则的 `[^；]+` 会吃进 `）` 等字符，
产出 `"stop_button）"` 这类脏值，同样破坏调用方的等值比较。

### 5. 工具面合并（v0.9.0）的漏改收尾

| 漏改 | 后果 |
|---|---|
| `skills/tianshu-mcp/SKILL.md` 3 处**操作指令**仍写 `cancel_task` | agent 照文档调用 → `Tool not found` |
| 3 个 smoke 脚本调用旧工具名 | 真机实测主路径直接报错 |
| `rework-repair-hint.test.ts` 的用例**是假绿**（调不存在的工具却只断言 `isError`） | 掩盖缺陷，永远绿 |
| `verify-params.test.ts` 无参白名单含已删除的 `get_profiles` | 白名单静默失效 |

---

## 新增：TraeWork 真机冒烟脚本

```
npm run smoke:traework -- --confirm-send \
  --model "DeepSeek-V4.1-Flash" --mode Code \
  --project "<绝对路径>" --task "<任务书>" \
  [--cancel-after-ms 25000] [--auto-verify]
```

- **三件套护栏**：`--confirm-send` / `--model` / `--task` 三者齐全才发送（缺任一打印用法并退出 2）。
- `--mode <Work|Code|Design>`：TraeWork 三模式面板，项目绑定**按模式隔离**。
- `--cancel-after-ms`：进入运行后触发取消，用于验证「点停止按钮 + 有界等待」路径。
- 隔离数据目录，不污染 `~/.tianshu-mcp`。

---

## 验证

### 真机终验（Code 模式 + DeepSeek-V4.1-Flash + `D:\Trae项目\AI游戏\Minecraft`）

| 路径 | 结果 |
|---|---|
| 成功 | `succeeded`；产出 SVG 符合任务书（512×512、3/8 草绿 `#5D9C3C` + 5/8 土棕 `#8B5A2B` + 两排 `#3E6B27` 锯齿） |
| 排队 | 同一份真实 DOM 回放：修复前 `finished`（假成功）→ 修复后 `queue`（位次 1064） |
| 取消 | 修复前 `guiStop={clicked:false,idle:false}` + 「无停止结果可确认」→ 修复后 `{clicked:true,idle:true}` + 「已确认运行停止」，约 1.2s |

### 门禁

```
tsc --noEmit                    exit 0
eslint . --max-warnings 0       全绿
vitest run                      1673 passed / 12 skipped
```

### 回归锁（全部经反证验证）

| 文件 | 锁什么 | 反证 |
|---|---|---|
| `test/unit/traework-cancel-path.test.ts` | `await` 不可漏、`click()` 坐标优先、`stopButton` 是图标元素 | 注入回归 → 精确变红 |
| `test/unit/last-run-signal-contract.test.ts` | 6 个 GUI 适配器的 note 契约 + 值无尾随脏字符 | 注入旧文案 → 变红 |
| `test/unit/traework-reply.test.ts`（排队 4 例） | 排队不误判完成 + 假阳性防护 | 移除排队判定 → 3 条变红 |

---

## 升级注意

**无需改调用方**：工具面、参数、返回结构均未变更。直接升级即可。

已知既存环境失败（**与本版无关**，仅供参考）：`spawn-regression`（本机缺 `tianshu-runtime.exe`）、
`codex-flow`；已用改动前 HEAD 的 git worktree 对照确证。

---

## 边界（本版没做什么）

- **未加排队时长上限**：排队时适配器会一直等到 `taskTimeoutMs`（默认 30 分钟）。
  「排队超过 N 分钟就提前结束」属产品决策，本版只做「如实上报」不做策略变更。
- **未支持 traework 的 `continue_task`**：traework 仍不在 `continue_task` 支持名单，
  故排队未走 `needs_user`（会造成无法恢复的死路）。

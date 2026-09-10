# HANDOFF.md — 项目交接说明

> 交接快照：**2026-09-10**（v0.1.10 修复 stdio 日志污染）。本文写给**接手本仓库的人**：先读「交接快照」了解当前状态，再按「从零搭环境」上手。
> 工作区规则见 `AGENTS.md`（gitignore 中，仅本地），安装/用法见 `README.md`，本文不重复，只做导览与状态记录。

---

## 1. 这个项目是什么

`tianshu-mcp` 是一个**被天枢（Tianshu）当作标准 MCP server 接入的编排层**：天枢是总指挥，本 server 负责**调度 + 执行面 + 客观验收仪**，驱动外部 AI-Agent 完成闭环：

```text
项目开发 → 验收 → 失败返修 → 再验收
```

- **天枢官方仓库**：<https://github.com/huiliyi37/Tianshu-harness>（基于 harness 工程的终端编程智能体运行时，TUI × GUI；Apache-2.0）
- **本仓库**：`github.com/lanlan0811/tianshu-mcp`（主）｜`gitee.com/lan0811/tianshu-mcp`（镜像）
- **npm**：`tianshu-mcp`（当前 `0.1.10`）

### 为什么是这样设计的（硬约束）

本项目的形态由三个**实测硬约束**决定，改架构前必读：

1. **天枢的 MCP 工具只回文本**：MCP 响应里 `content[]` 的 `text` 项被拼成字符串，`isError` 透传。因此所有结果统一为「人类可读文本 + `---tianshu-mcp-meta---` JSON 块」，不依赖 resources/prompts。
2. **天枢按次同步调用 `tools/call`**：长任务必须异步化 → `run_task` 秒回 `taskId`，用 `query_task` 轮询。
3. **TraeWork 的 agent 请求在 TTNet 层 TDE 加密**，无法在客户端外构造 → 唯一可行路径是 CDP 驱动其桌面 UI，从 DOM 提取结果。

---

## 2. 交接快照

| 项 | 状态 |
|---|---|
| 分支 | `master`（**只在此分支提交**，不建其他分支） |
| 发布提交 | `dc471d2 修复 TraeWork 任务进行中检测并发布 v0.1.9`（v0.1.10 修复提交见本次交付记录） |
| 版本 / 许可证 | `0.1.10` / Apache-2.0 |
| 标签 | `v0.1.0` … `v0.1.9`（v0.1.2+ 均已推双仓；v0.1.10 tag 待发布时打） |
| 工作树 | 本次修复变更集（含严格 stdio 门禁与双语文档） |
| 测试 | **202/202 通过**（31 个测试文件：单元 20 + 集成 10 + 协议 1） |
| 门禁 | lint 0 warning、typecheck clean、build 成功、`check:stdio` 6/6 场景通过、`npm pack` 内容校验通过 |
| CI | `CI` workflow：ubuntu/windows/macos × Node 20/22/24 + 严格 stdio + 安装包协议检查 |
| npm | v0.1.10 发布状态按实际结果记录（本仓库只在 `release.yml` 创建 GitHub Release 草稿，npm/Gitee 需单独发布） |
| Release | v0.1.10 发布状态按实际结果记录 |

### Agent 适配现状

| agentId | driver | status | 说明 |
|---|---|---|---|
| `codex` | `spawn` | **ready** | 复用 `~/.codex` 登录态；`codex exec` 无头执行；M2 真实冒烟通过 |
| `zcode` | `spawn` | **unsupported** | ZCode 桌面无随包 headless CLI（Z1 定论） |
| `traework` | **`gui`** | **ready** | CDP 驱动 TRAE SOLO CN 桌面 UI；三种面板模式真机验证通过 |
| `stub` | `spawn` | 仅测试 | `test/stub-agent/stub-agent.mjs` 三剧本（good/fix-on-first/never） |

---

## 3. 里程碑记录（简版，详见 `CHANGELOG.md`）

- **M1** 核心引擎 + stub-agent 全链路（8 工具、状态机、队列、验收引擎、fix-loop）— 53 测试
- **M2** 真实 Codex CLI 冒烟 + rework 闭环；修复 3 个真实缺陷
- **M3** TraeWork 调研 → 定论「无无头 CLI」；npm 首发；天枢宿主真实接入（DoD #6）
- **R1–R8 / S1–S6** 两轮验收整改（取消/超时/基线归因/参数语义/热加载/CI 加固）— 72 测试
- **M4** TraeWork GUI 驱动接入（CDP）——`driver=gui` 落地，真机 e2e 通过 — 153 测试
- **M5** 面板模式切换（Work/Code/Design）+ v0.1.5 发布 + README 重写/SVG 资产 — **167 测试**
- **M6** 项目文件夹绑定修复（footer 确认弹窗 / 检测预算 / CJK 路径 WM_SETTEXT / Code→Work 兜底）+ v0.1.6 — **172 测试**
- **M7** 绑定**根因**修复（规范化路径被选择器拒绝 → `toNativeWindowsPath`）+ 写入回读校验 / hwnd 贯穿 / 遗留对话框清理 + v0.1.7 — **178 测试**
- **M8** 原子写并发缺陷修复（临时文件名唯一化 + rename 退避重试，CI windows/Node20 真根因）+ v0.1.8 — **181 测试**
- **M9** TraeWork 任务进行中检测（权威运行信号 + 空闲计时 + CDP 断线收敛 + 异常保留实例）+ v0.1.9 — **196 测试**
- **M10** stdio 日志污染修复（issue #1：Logger 全级别改走 stderr + 严格 stdio 门禁 + Node 24 + 安装包协议门禁）+ v0.1.10 — **202 测试**

### 实现期修复记录（重要）

1. **rework 反馈竞态**（`TaskManager`，负载下偶发）
   - 现象：`rework_task(feedback)` 后返修轮拿不到 feedback，卡在 `failed`。
   - 根因：终态快照先落盘，调用方立即写入 `reworkFeedback`；上一轮收尾的 `delete meta.reworkFeedback` 把它抹掉。
   - 修复：改为 `startTask` 启动时**原子取走并清空**。回归：`test/integration/rework-feedback-race.test.ts`。
2. **`projectBasename` 跨平台**：原用 `path.basename`（POSIX 不切反斜杠），Linux/macOS CI 必失败 → 改为显式按 `\` 与 `/` 切分。
3. **项目文件夹绑定卡住**（M6，实战反馈）：三处叠加缺陷 —— footer 点击未确认弹窗、检测被 PowerShell 冷启动吃光预算、CJK 路径被控制台代码页破坏。详见 §8.1。
4. **绑定仍失败的真根因**（M7）：MCP 传 `normPath()` 规范化路径（`d:/a/b`），**Windows 原生选择器不接受** → 必须 `toNativeWindowsPath()` 转 `D:\a\b`。详见 §8.1。
5. **原子写并发缺陷**（M8，CI 偶发失败真根因）：`writeJsonAtomic`/`writeTextAtomic` 临时文件名
   `<目标>.<pid>.tmp` 在并发下共用 → `ENOENT`（同进程）或 `EPERM`（Windows rename 争用）；
   已改为随机后缀 + rename 退避重试。回归：`test/unit/atomic-write.test.ts`。
6. **长思考被提前判完成**（M9）：稳定 36 秒不再等同完成；停止按钮与 loading task tail 优先于完成标志，
   静态确认后再等待默认 10 分钟才返回 `idle`。异常结束保留实例，详见 §8.2。
7. **stdio 日志污染**（M10 / v0.1.10，issue #1）：统一 `Logger` 只有 ERROR 走 `console.error`，
   INFO/WARN/DEBUG 走 `console.log`，与 MCP JSON-RPC 共用 stdout → 严格客户端握手/调用失败。
   修复：全级别统一 stderr，stdout 只承载协议消息。回归：`test/unit/log.test.ts` +
   `scripts/check-stdio.mjs`（真实进程字节流校验，6 场景），ESLint `no-console` 兜底。详见 §8.3。

---

## 4. 架构与模块导览

```text
src/
├── index.ts              入口（stdio）
├── server.ts             组装：配置/日志/管理器/引擎/注册表/工具注册/技能自检安装
├── config/
│   ├── schema.ts         zod 全集（工具入参、profile、projects、验收配置、TraeworkMode）
│   └── store.ts          数据目录读写 + last-known-good 热加载
├── mcp/
│   ├── tools.ts          8 个工具的元数据（name/description/inputSchema/capability/approval）
│   ├── handlers.ts       工具实现
│   ├── context.ts        meta → TaskContext
│   └── formatter.ts      文本 + meta 块
├── tasks/                状态机、每项目串行队列、全局并发闸、事件流落盘
├── loop/
│   ├── fix-loop.ts       单任务编排（自动返修循环）
│   └── repair-plan.ts    验收失败时生成修复计划文件
├── agents/
│   ├── adapter.ts        AgentAdapter 接口（含可选 run() 执行面）
│   ├── registry.ts       按 profile.driver 构造 adapter（spawn→CliAdapter，gui→TraeworkGuiAdapter）
│   ├── cli.ts            通用 CLI adapter
│   ├── spawn.ts          子进程封装（windowsHide/stdio 管道/超时/kill tree）
│   ├── builtin.ts        内置 profiles（codex/zcode/traework）
│   └── traework/         GUI 驱动
│       ├── adapter.ts / run.ts / launcher.ts
│       ├── cdp/{client,selectors}.ts
│       ├── ui/{session,composer,model,reply}.ts
│       └── computeruse/{guard,dialog}.ts
├── verify/               验收引擎（命令检查 + 代码分析 + git 基线 + 报告）
└── util/                 日志、路径、文件、超时、技能安装
```

### 两条执行面（`driver`）

| driver | 执行方式 | 结果判定 |
|---|---|---|
| `spawn`（默认） | 拉起外部 CLI 子进程 | 退出码 |
| `gui` | CDP 驱动桌面 UI，**不 spawn** | 运行信号优先 → DOM 完成标志 → 稳定确认后的空闲计时 → 任务超时 |

`TaskOrchestrator.runAgentOnce` 的分支逻辑：`adapter.run` 存在 → 调用它；否则走 `runChild`。**这是唯一需要理解的双路径接缝。**

### TraeWork 执行顺序（实测结论，勿随意调整）

```text
确保实例可用 → 等待 UI 就绪 → 新建会话 → 切到目标模式 → 在目标模式内绑定项目 → 切模型 → 发送 → 轮询到完成
```

> **关键事实**：TraeWork 的 Work/Code/Design **各自维护独立的项目绑定**，切换模式会把输入栏项目换成该模式上次使用的项目。
> 因此必须先切模式、再在目标模式里绑定项目；绑定后复核「模式 + 项目」双双就位，任一不符即响亮失败。

---

## 5. 硬性红线（违反 = 运行时损坏或事故，改架构前必读）

1. **绝不按进程树盲杀 TraeWork**：只终止本模块创建、且命令行核对通过的 PID，且不带 `/T`。
   事故来源：验证期 `taskkill /PID <pid> /T /F` 误杀用户正在使用的实例（数据完好，已恢复）。见 `docs/traework-cdp.md §6`。
2. **默认复用用户实例**：`gui.windowMode="reuse"`，绝不新起第二个。
3. **computer-use 白名单**：仅允许 TraeWork 文件夹选择对话框（窗口标题 + 宿主进程双校验），其他窗口一律 `COMPUTER_USE_DENIED`。
4. **凭证零管理**：不读取/解密/转发任何 agent 凭证；TraeWork 只驱动 UI。
5. **命令不拼 shell**：验收命令是结构化 argv，`shell:false`。
6. **不自动 commit/stash/回滚**：动工前采集 git 基线，报告相对基线计算。
7. **路径不硬编码**：机器路径/用户名/端口走 profile 或占位符（`{LOCALAPPDATA}` 等）。
8. **只在 `master` 提交，commit 用中文**。

---

## 6. 从零搭环境 + 日常迭代

```bash
git clone https://github.com/lanlan0811/tianshu-mcp.git
cd tianshu-mcp
npm ci
npm run build        # sync-version + tsc → dist/
npm test             # 202 项
```

日常循环（改 `src/` 后）：

```bash
npm run typecheck && npm run lint && npm test && npm run build
# 通过后：git add . && git commit -m "中文说明" && git push github master && git push gitee master
```

### 本机环境事实（2026-09-08 探测，接手机器可能不同）

| 项 | 值 |
|---|---|
| Node | v24.18.0（`engines: >=20`，CI 覆盖 20/22） |
| 天枢宿主 | `D:\Tianshu`（`tianshu-desktop.exe` + `rivet-runtime`） |
| Codex CLI | `C:\Users\Lenovo\AppData\Local\OpenAI\Codex\bin\<hash>\codex.exe`（哈希目录随更新变化 → 用 `executableDiscovery`） |
| TraeWork | `D:\TRAE Work CN\TRAE SOLO CN.exe`（v1.107.1）；CDP 需 `--remote-debugging-port=9222` 且窗口可见 |
| 参考实现 | `D:\Trae项目\oh-dsh-trae-api`（TraeWork CDP 驱动机制的来源，含 `HANDOFF.md`） |
| 数据目录 | 默认 `~/.tianshu-mcp`（env `TIANSHU_MCP_HOME` 可覆盖） |
| 技能安装 | `~/.rivet/skills/tianshu-mcp`（server 启动自检幂等安装） |

### 真机验证（**不入 CI**，需真实客户端在跑）

```bash
node scripts/probe-traework.mjs selectors          # 选择器命中检查
node scripts/probe-traework.mjs mode Code          # 切面板模式
node scripts/probe-traework.mjs project <绝对路径>  # 新建会话 + 绑定项目
node scripts/probe-traework.mjs send "任务书"       # 端到端发一条并取回复
```

---

## 7. 测试分层

| 层级 | 位置 | 说明 |
|---|---|---|
| 单元 | `test/unit/` | 纯函数与组件逻辑（含 traework reply/selectors/launcher/guard/repair-plan/driver/session） |
| 集成 | `test/integration/` | stub-agent 三剧本、取消/超时/基线、TraeWork 假 CDP（单轮 + 返修闭环）、rework 竞态回归 |
| 协议 | `test/protocol/` | 官方 SDK 客户端断言 8 工具面与返回格式 |
| 真机 | `scripts/probe-traework.mjs` | **手动**，需真实 TraeWork |

假 CDP 桩在 `test/fake-cdp.ts`：**助手回复必须同步追加**（`autoReplyText`），不要改回定时器——轮询间隔小 + `stableRounds` 低时定时器会与稳定兜底抢跑（已在 CI 上翻车过一次）。

---

## 8. 已知限制（对接手人有直接影响）

- **TraeWork 窗口必须可见**：发送依赖模拟输入。
- **单会话串行**：TraeWork 是单会话 UI，所有任务经串行队列。
- **完成判定依赖 UI 信号**：停止按钮 / loading task tail 存在时不结束；无运行信号才接受「由AI生成」。
  `stableRounds` 只启动 `idleTimeoutMs`（默认 10 分钟）空闲计时，不再把约 36 秒静态直接当完成。
- **异常结束保留实例**：`idle_no_completion` / `timeout` / `aborted` / `cdp_lost` 均不关闭现场；
  `query_task` meta 查看 `agentEndReason` / `keptInstance`。
- **UI 升级会漂移**：选择器集中在 `src/agents/traework/cdp/selectors.ts`，可经 profile `gui.selectors` 覆盖；用探针诊断。
- **macOS 未验证**：CDP 机制平台无关，但可执行探测与原生对话框驱动（AppleScript 路线）未实测；当前 macOS 分支 fail-closed。
- **`mode` 仅 GUI 类 agent 生效**：CLI 类（codex）忽略该参数。
- **原生对话框链路依赖桌面状态**：TraeWork 窗口必须可见，且不能有第三方工具（如 Snipaste 截图器）抢焦点。
- **npm 上的 README 停留在发布时**：之后新增的文档只在仓库里；如需同步到 npm 需再发版本。

---

## 8.1 TraeWork 项目文件夹绑定排障（M6 实战教训）

### 事实：下拉项 ≠ 项目 map

| 数据源 | 说明 |
|---|---|
| 下拉列表（`readProjectItems`） | 来自 TraeWork **服务端**项目列表，实测本机 11–12 项 |
| `solo-lite.local-project-folders`（state.vscdb） | 仅本地**路径回填缓存**，实测 22–23 条 |

两者不是同一份数据。**「项目已在 map 里」不代表下拉能命中**——未命中仍会走原生对话框。
（曾误判为「项目已注册所以不该走对话框」，实测证伪。）

### 三处叠加缺陷（2026-09-08 修复）

1. **footer 点击未确认弹窗**：`element.click()` 返回 true ≠ 原生弹窗出现。
   旧代码只看返回值 → 日志报「等待原生对话框超时」（下游症状）。
   **修复**：点击后调 `findFolderDialog()` 确认，未出现则记录下拉 DOM 快照并明确失败。
2. **检测预算被 PowerShell 冷启动吃光**：实测冷启动 **4.5–6.3s/次**（UIA 与 Win32 都一样），
   旧代码 Node 侧每 800ms 轮询 → 15s 只够约 2 次。
   **修复**：单次 PowerShell 调用内轮询（400ms 间隔），预算 30s；`spawnSync` → 异步 `spawn`。
3. **CJK 路径被控制台代码页破坏**：实测 `D:\Trae项目	s-bind-test` 被写成 `D:Traes-bind-test`。
   **修复**：改用 Win32 **`WM_SETTEXT`**（句柄由 UIA 提供）写编辑框。

### ★ 真根因（M7 / v0.1.7）：路径形式不对

MCP 内部传给对话框的是 `normPath()` **规范化路径**（小写盘符 + 正斜杠，如 `d:/Trae项目/AI游戏/象棋`），
而 **Windows 原生文件夹选择器不接受该形式**。实测对照（同一对话框、同一台机器）：

| 写入 | 回读 | 点确认后 |
|---|---|---|
| `d:/Trae项目/AI游戏/象棋` | `d:/Trae项目/AI游戏/象棋` | **对话框不关闭**（路径被拒） |
| `D:\Trae项目\AI游戏\象棋` | `D:\Trae项目\AI游戏\象棋` | **对话框关闭，绑定成功** |

**注意**：回读校验会「通过」，因为写进去的确实是那个字符串——所以**光有回读校验不够**，
必须先把路径转成原生形式（`toNativeWindowsPath()`：正斜杠→反斜杠 + 盘符大写）。

配套修复：写入后 `WM_GETTEXT` 回读 + 重试（最多 3 次，失败不点确认）、
hwnd 贯穿传递（只操作探测到的那个窗口）、下拉未命中时先清理遗留对话框、
确认按钮要求矩形在对话框下半部。

### 另外两个定位陷阱（已修）

- **确认按钮 `AutomationId="1"` 不唯一**：文件列表行也用 0/1/2…。必须用
  **AutomationId=1 且 ControlType=Pane** 组合定位（实测误点到 `.rivet` 列表项）。
- **「文件夹」编辑框**：`AutomationId=1152` 且 **ClassName=`Edit`**（它是 Pane 类型、无 ValuePattern）。

### 排障顺序（下次遇到卡住先做这几步）

1. `node scripts/probe-traework.mjs selectors` —— 确认选择器是否命中。
2. 看任务日志 `<home>/tasks/<taskId>/agent-0.log`：区分「下拉未命中」「对话框未弹出」「写入失败」「确认失败」。
3. 手工验证对话框是否开着：
   ```bash
   powershell -NoProfile -Command "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes; \$r=[System.Windows.Automation.AutomationElement]::RootElement; \$c=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Window); foreach(\$w in \$r.FindAll([System.Windows.Automation.TreeScope]::Children,\$c)){ if(\$w.Current.Name -match 'TraeWork'){ foreach(\$d in \$w.FindAll([System.Windows.Automation.TreeScope]::Descendants,\$c)){ Write-Output \$d.Current.Name } } }"
   ```
4. **不要**用 TraeWork 的 `--folder-uri` / `-a` 预注册（已证伪：只写原生 `history.recentlyOpenedPathsList`，
   Solo 下拉不读它）；**不要**直写 `state.vscdb` 的 map（renderer 有内存缓存，且 key 需后端 `createProject` 分配）。

---

## 8.2 TraeWork 任务进行中检测（M9 / v0.1.9）

### 信号优先级与选择理由

1. 字面「思考中」先保持 `pending`；原生 `ask_user` 仍立即结束本轮。
2. `.chat-input-v2-send-button-stop-icon`（主）与 `.core-task-tail--loading`（次）是权威运行信号：
   任一可见时，即使 DOM 已有完成标志也必须继续等待，并清零稳定轮数/空闲计时。
3. `.thinking-stream-content` 与工具卡片只作诊断。它们会残留在历史消息，若作为阻塞条件会永久不结束。
4. 无运行信号时才接受「由AI生成」完成标志；无完成标志则在 `stableRounds` 轮静态确认后，继续静态
   `idleTimeoutMs`（默认 600000ms）才返回 `idle_no_completion`。

所有信号通过 `selectors.ts` 的主选择器、回退与 profile 覆盖解析。若 UI 升级导致全部新选择器未命中，
探针按 `running=false` **失败开放**，退回完成标志 + 空闲计时，避免选择器漂移造成永久卡死。

### CDP 与实例保留策略

- CDP WebSocket `close` / `error` 会拒绝全部 pending；单次 `send()` 默认 15000ms 超时。
- 轮询观测与 abort、任务 deadline 竞争，取消最多约 1 秒生效；默认每 30000ms 发一条 `note` 进度事件。
- 只有 `completion_mark` / `ask_user` 会释放本模块启动的实例。
- `idle_no_completion` / `timeout` / `aborted` / `cdp_lost` 均保留实例，结果与任务 meta 写入
  `agentEndReason` / `keptInstance`。超时文案不再错误声称「进程树已终止」。

### 2026-09-09 真机与发布物证

| 项 | 结果 |
|---|---|
| 活跃 DOM 探针 | `stopButton=true`、`taskTailLoading=true`，空闲后均恢复 false；thinking stream 仅诊断 |
| 长任务 | `tsk_20260909073026_79600a` 持续生成约 92 秒；30 秒进度记录 stop，60 秒记录 stop+tail；最终 `completion_mark`，验收 2/2 通过 |
| 极短超时 | `tsk_20260909073242_f81f0f`：`timeout=true`、`agentEndReason=timeout`、`keptInstance=true`；PID 16264 命令行与 9222 端口复核仍存活 |
| 正常短任务 | `tsk_20260909073328_dd4dc8`：`completion_mark`，验收 2/2 通过 |
| 本地门禁 | `typecheck`、`lint`、`build`、`pack:check` 全绿；30 文件 **196/196** 测试通过 |
| GitHub CI | run `34292477632`：ubuntu/windows/macos × Node 20/22 + tarball，共 **7/7** 全绿 |
| Release / npm | GitHub 与 Gitee `v0.1.9` 均正式发布并附 tarball；npm `tianshu-mcp@0.1.9`，`latest=0.1.9` |

真机使用的独立项目、任务日志与报告均在仓库忽略目录 `.tianshu-mcp/` 下，不进入发布产物；验证实例在
完成存活确认后按「PID + 可执行名 + 调试端口」核对，并以非树式方式安全关闭。

## 8.3 stdio 日志污染修复（M10 / v0.1.10，issue #1）

### 事实与根因

- MCP stdio 规范：**stdout 只承载合法 MCP JSON-RPC 消息**，诊断日志应写 stderr。
- 旧 `src/util/log.ts` 只有 `error` 走 `console.error`，`info`/`warn`/`debug` 走 `console.log`（stdout）。
  默认 INFO 阈值下，连接提示、技能自检、任务状态等都会污染协议流，且可延续到握手之后。
- 复现（旧实现，`node --import tsx src/index.ts`，隔离 HOME）：6 个场景全部在 stdout 出现
  `[INFO] …` 非协议行；证据见 `docs/m2-evidence/issue1-old-impl-stdio-check-failure.txt`。

### 修复与门禁

- `src/util/log.ts`：所有通过阈值的级别统一 `console.error`（stderr），日志文件追加行为不变。
- `eslint.config.js`：`src/**/*.ts` 启用 `no-console`（仅允许 `error`），阻止再次直接写 stdout。
- `scripts/check-stdio.mjs`：真实子进程捕获完整 stdout/stderr，逐行用官方 `JSONRPCMessageSchema`
  校验，空行/非 JSON/parser error/退出残留片段即失败；覆盖首次启动、再次启动、`--no-skill-install`、
  损坏 `config.json`、stub 任务运行期日志、EOF 关闭 6 场景。消费者安装 tarball 后复用同一脚本。
- 回归：`test/unit/log.test.ts` 以子进程探针断言四级通道、默认 INFO 过滤、文件阈值与 UTF-8。

### 2026-09-10 本地门禁物证

| 项 | 结果 |
|---|---|
| 修复前 | `test/unit/log.test.ts` 4/6 失败；`check-stdio` 6/6 场景失败（证据已归档） |
| 修复后 | 源码入口与 `dist` 入口 `check:stdio` 均 **6/6 通过**，stdout 非协议行 0 |
| 安装包 | tarball 安装到干净消费者目录（不装 dev 依赖）后 6/6 通过 |
| 门禁 | `typecheck` / `lint` / `build` / `check:stdio` / `pack:check` 全绿；31 文件 **202/202** 测试通过 |

---

## 9. 凭证与安全红线

- 仓库内**不含任何 token**；`~/.npmrc`、`~/.git-credentials`、`GITEE_ACCESS_TOKEN` 均为本机凭证，勿入库。
- `.gitignore` 隔离：`AGENTS.md`、`.zcode/*`、`.codex/*`、`.rivet/*`、`analysis-tools/*`、`/.tianshu-mcp/*`、`node_modules/*`、`dist/*`。
- 发布需要：npm `_authToken`（账号 `lotteai`）、GitHub token（`~/.git-credentials`）、`GITEE_ACCESS_TOKEN`。
- 安全模型与私密报告渠道见 `SECURITY.md`。

---

## 10. 文档地图

| 文档 | 内容 |
|---|---|
| `README.md` / `README.en.md` | 项目总览、快速开始（含天枢界面配置）、文档索引 |
| `CHANGELOG.md` / `.en.md` | 版本历史 v0.1.0 → v0.1.10 |
| `CONTRIBUTING.md` / `.en.md` | 开发环境、门禁、规范、提交/发布流程、如何新增 agent |
| `SECURITY.md` / `.en.md` | 安全模型与漏洞报告 |
| `CODE_OF_CONDUCT.md` / `.en.md` | 行为准则 |
| `docs/tianshu-integration.md` / `.en.md` | 接入配置、冒烟步骤、FAQ |
| `docs/traework-cdp.md` / `.en.md` | TraeWork GUI 驱动原理、选择器、安全红线、踩坑记录 |
| `docs/agent-profiles.md` / `.en.md` | profile 字段说明（含 `driver`/`gui`） |
| `docs/adapter-matrix.md` / `.en.md` | 各 agent 能力调研矩阵 |
| `docs/acceptance-config.md` / `.en.md` | 项目级验收配置规范 |
| `docs/release-v0.1.10.md` / `.en.md` | v0.1.10 发布说明（stdio 日志污染修复，issue #1） |
| `docs/release-v0.1.9.md` / `.en.md` | v0.1.9 发布说明（任务进行中检测与实例保留） |
| `docs/release-v0.1.8.md` / `.en.md` | v0.1.8 发布说明（原子写并发缺陷修复） |
| `docs/release-v0.1.7.md` / `.en.md` | v0.1.7 发布说明（绑定根因：原生路径形式） |
| `docs/release-v0.1.6.md` / `.en.md` | v0.1.6 发布说明（项目文件夹绑定修复） |
| `docs/release-v0.1.5.md` / `.en.md` | v0.1.5 发布说明与产物记录 |
| `docs/npm-publish-guide.md` | npm 发布步骤与凭证 |
| `docs/m2-*.md`、`docs/host-integration-record.md`、`docs/dod7/dod8-*` | 历史里程碑物证（中文，无英文版） |
| `skills/tianshu-mcp/SKILL.md` | 教天枢编排本 MCP 的技能（随包分发、启动自检安装） |

> **本地 only（gitignore，不在仓库）**：`.zcode/plans/tianshu-mcp-development-plan.md`（总开发计划）、
> `.zcode/plans/traework-gui-adapter-plan.md`（TraeWork GUI 计划，M1–M5 已完成）、`.codex/review/`（验收报告）。

---

## 11. 接手人下一步建议

1. 先跑 `npm ci && npm run typecheck && npm run lint && npm test && npm run build`，确认基线绿。
2. 读 `README.md` + `docs/traework-cdp.md §6/§8`（安全红线与踩坑），再动 TraeWork 相关代码。
   项目文件夹绑定出问题时，先看本文 §8.1 的排障顺序（下拉项 ≠ 项目 map、三处已修缺陷、两个定位陷阱）。
3. 若 TraeWork 升级导致选择器失效：用 `scripts/probe-traework.mjs selectors` 诊断，优先用 profile `gui.selectors` 覆盖，不改代码。
4. 新增 agent：优先只加 profile（见 `docs/agent-profiles.md`）；需要特殊输出解析再写 adapter。
5. 发版前务必确认 `src/version.generated.ts` 与 `package.json` 同步提交（CI 有「构建后无 tracked diff」门禁）。

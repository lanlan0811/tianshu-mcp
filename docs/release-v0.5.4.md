# tianshu-mcp v0.5.4 发布说明

[English](release-v0.5.4.en.md)

**核心主题**：**视觉验收第二阶段——AI 视觉内容校验（issue #13）**。在第一阶段（v0.5.0）的客观像素对比与静态图片规格检查之外，新增一个**可选、默认关闭**的内容校验维度：校验图片或页面截图的内容是否符合你显式声明的期望描述（Logo 元素、风格匹配、页面语义等）。

本版本为 **PATCH**：新增可选能力且**默认关闭**，既有工具签名、报告字段与 `pages`/`images` 默认行为**保持向后兼容**。唯一需要消费方注意的是枚举扩展——`VisualResult.status` 新增 `"uncertain"`、`kind` 新增 `"content"`，严格穷举 `status` 的外部消费方需一并处理。

## 定位

issue #3 把「AI 校验图片内容是否符合任务描述」列为可选扩展，其客观部分（截图对比、图片规格、基准批准、离线报告）已随 v0.5.0 交付。本版本收官该扩展，并回应 issue #13 提出的五个设计问题：

| issue #13 的问题 | 本版本结论 |
|---|---|
| 模型与凭证来源（不得破坏「凭证零管理」红线） | **只委托用户自定义命令**：不做模型客户端、不内置 agent CLI 预设、不读密钥。判定命令自己管它的登录态/密钥 |
| 可复现性（避免判定抖动导致返修空转） | 输入哈希缓存保证同产物同结论；单次判定默认 3 采样多数票，票不集中 → `uncertain`（永不阻塞、不触发返修）；告警项本身也不进门禁 |
| 门禁定位（默认仅告警 vs 计入失败） | 默认**仅告警**；逐规则 `blocking: true` 才升级为致败项并进入返修计划 |
| 成本与超时 | `content.timeoutMs`（默认 90000ms）为单项超时；采样数逐规则可配（≤9）；缓存让同输入零重跑；**配置期硬校验** `samples × timeoutMs ≤ limits.roundTimeoutMs`（违反即 `CONFIG_INVALID`，不靠 `doctor` 事后提示）；`visual doctor` 另对多规则总预算给出建议值 |
| 离线与隐私默认值 | `allowRemote` 默认 `false`，字节外传占位符需逐规则显式放行；文档与 `SECURITY.md` 如实写明数据是否离开本机取决于用户命令，并标注 MCP 的强制力边界 |

## 新增能力

### 配置面

```jsonc
{
  "visual": {
    "enabled": true,
    "content": {
      "enabled": true,                                  // 默认 false，需显式启用
      "command": "vision-cli",
      "argsTemplate": ["judge", "--image", "<image:path>", "--expect-file", "<expect:file>"],
      "cwd": ".",
      "env": { "VISION_API_KEY": "MY_VISION_KEY" },     // 用户声明式引用，非密钥原文
      "allowRemote": false,                             // 默认禁止外发
      "samples": 3,
      "timeoutMs": 90000,
      "minConfidence": 0.6,                             // 省略即关闭置信度闸门
      "cache": true
    },
    "contents": [
      { "id": "logo-elements", "files": ["assets/logo.png"],
        "expect": "Logo 含蓝色齿轮图形与白色文字 TIANSHU", "blocking": false }
    ],
    "pages": [
      { "id": "home", "source": { "type": "static", "root": "dist" }, "route": "/" },
      { "id": "login-semantic", "source": { "type": "static", "root": "dist" }, "route": "/login",
        "pixel": false,                                  // 语义-only：豁免基准要求
        "content": { "expect": "存在用户名与密码输入框及登录按钮", "blocking": true } }
    ]
  }
}
```

配置默认关闭，声明了规则却不启用、有效命令/模板缺失、未知占位符、未放行 `allowRemote` 却使用字节外传占位符、
`samples × timeoutMs` 超预算、派生 id 冲突等一律在 schema 层拒绝。

### 命令契约

- 占位符：`<image:path>`（图片绝对路径）、`<expect:file>`（期望文本临时文件）、`<image:base64:file>`（图片 base64 临时文件，需 `allowRemote: true`）。其他 `<...>` token 拒绝。
- stdout **末行**必须是严格 JSON：`{ "passed": boolean, "confidence"?: 0..1, "reason": string }`。
- 退出码 `0` 表示命令正常执行（**不代表判定通过**）；非 `0` 为命令执行失败。
- 期望文本经临时文件传递，规避命令行转义与长度上限，也避免进入进程命令行与系统审计日志；临时文件每轮采样后在 `finally` 中删除。
- 子进程 `shell: false` + 结构化 argv，超时杀进程树。

### 判定与防抖

- 单项内**串行**采样（项间仍受 `limits.concurrency` 约束），多数票决定通过/不通过。
- 票不集中，或有效置信度低于 `minConfidence` → `CONTENT_UNCERTAIN`（既不致败也不触发返修）。
- 缓存键含图片摘要、期望文本、命令字符串、**命令绝对路径与二进制摘要**、参数模板、cwd、环境值摘要、`allowRemote`、`samples`、`minConfidence`——自备 CLI 升级即自动失效。
- `minConfidence` 在命令不报 confidence 时**不生效**（刻意的，避免误伤），报告会标注该状态。
- 逃生门：`content.cache: false` 关闭缓存；`tianshu-mcp visual content cache clear <taskId>` 清理。

### 原因码

| 原因码 | status | 可返修 | 触发条件 |
|---|---|---|---|
| `CONTENT_MATCH` | passed | 否 | 多数票满足期望 |
| `CONTENT_MISMATCH` | failed | 是 | 多数票不满足期望 |
| `CONTENT_UNCERTAIN` | uncertain | 否 | 票不集中或低于 `minConfidence` |
| `CONTENT_COMMAND_MISSING` | —（整轮） | — | 任一规则的**有效**命令不可解析 → 整轮 `configurationError`，不产出结果行 |
| `CONTENT_COMMAND_FAILED` | blocked | 否 | 命令退出码非 0 |
| `CONTENT_TIMEOUT` | blocked | 否 | 单项超时 |
| `CONTENT_OUTPUT_INVALID` | blocked | 否 | stdout 末行缺失/非 JSON/字段不合法 |
| `CONTENT_ENV_MISSING` | —（整轮） | — | 声明的宿主环境变量缺失 → 整轮 `configurationError`，不产出结果行 |
| `CONTENT_CONFIG_INVALID` | blocked | 否 | 运行期兜底（正常由 schema 拦截） |

### CLI 与诊断

```sh
tianshu-mcp visual content probe /path/to/project [ruleId]   # 跑真实判定但不写证据、不写缓存
tianshu-mcp visual content cache clear TASK_ID               # 清理任务级判定缓存（无需 --apply）
tianshu-mcp visual doctor /path/to/project                   # 新增内容命令解析与预算对比两项 finding
```

## 红线与数据外发声明

**凭证零管理（不新增任何凭证读取）**：MCP 不读取、不存储、不转发任何密钥，不实现模型/厂商 HTTP 客户端，
不内置 agent CLI 预设。判定完全委托你声明的本地命令。

**数据外发的强制力边界（请如实理解）**：图片是否离开本机**取决于你自备命令的行为**，MCP 无法在系统层拦截。
MCP 的强制力仅在契约层——`allowRemote` 默认 `false`，未放行的规则使用 `<image:base64:file>` 会被 schema 直接
拒绝；`visual doctor` 会列出各规则的 `allowRemote` 声明。请自行确认命令的实际行为。

## 缺陷修复

**返修计划把 `optional:true` 的失败列为「必须修复」**（issue #13 验收标准要求修复）：`repair-plan.ts` 的 `failed`
过滤条件原先只排除 `skipped`，导致仅告警的检查失败也被列进第 2 节「必须修复」。现补 `!c.optional`，并新增第 3.2 节
「仅告警项（不必修复）」列出 optional 检查失败与 `optional:true`/`uncertain` 的视觉项，同时在第 5 节明确要求
**不得为消除告警而伪造产物或放宽检查**。

## 升级指引

1. 升级后既有配置**无需改动**，行为与之前一致（内容校验默认关闭）。
2. 想启用内容校验：在 `.tianshu-mcp/acceptance.json` 的 `visual` 下把 `content.enabled` 设为 `true` 并提供自备
   命令与 `argsTemplate`；先用 `visual content probe` 验证命令可用与判定稳定，再正式跑验收。
3. 规则数 × 采样数与单项超时的乘积可能超出 `limits.roundTimeoutMs`（默认 300000ms，出厂默认 3 × 90000 = 270000
   已自洽）。启用时可先跑 `visual doctor` 看预算建议值；若需上调 `roundTimeoutMs`，注意它与 `samples × timeoutMs`
   必须保持自洽，否则 schema 会拒绝配置。
4. 消费 `VerifyReport` 的外部代码：若对 `VisualResult.status` 做穷举匹配，需补 `"uncertain"` 分支；若对 `kind`
   做穷举匹配，需补 `"content"`。

## 兼容性与定位说明

- 本版为 **PATCH**（0.5.3 → 0.5.4）：新增可选能力且默认关闭，既有签名/报告字段向后兼容。
- 内容校验项默认**仅告警**，不构成门禁；只有逐规则 `blocking: true` 才参与致败与返修。
- 启用内容校验会改变 `visual` 配置摘要，进而影响任务期内已冻结的快照：历史阻塞任务若因此报 `VISUAL_INTEGRITY`，
  走既有的 `visual rules review` → `visual rules approve` 显式批准，**不得绕过**。

## 测试与验证

- 全量 **638 passed / 12 skipped**（Windows 10 x64，Node 24.18.0），较 v0.5.3 净增 106 项用例。
- 12 项真实浏览器门禁用例在 Windows 10 本机以 `TIANSHU_VISUAL_BROWSER_TEST=1` 跑通 **12/12**，其中新增 2 项覆盖
  `pixel:false` 语义页豁免基准与「一次截图产出像素 + 内容两项」。
- `typecheck` / `lint`（`--max-warnings 0`）/ `build` / `check:stdio` 全部通过。
- **未覆盖项（如实标注）**：macOS 的真实系统证据待 CI `visual-browser` 作业采集；未与真实三方视觉 CLI 实测；
  「图片未离开本机」无法在系统层验证。详见 [验证进度](visual-validation.md)。

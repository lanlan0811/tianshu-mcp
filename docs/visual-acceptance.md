# 视觉验收（开发中，目标 v0.5.0）

[English](visual-acceptance.en.md)

视觉验收复用 `run_task`、`verify_task`、`get_task_report`、`query_task` 和 `rework_task`，支持客观页面截图对比与静态图片规格检查。**客观检查无 AI 参与**；可选的 AI 内容校验默认关闭，由用户自备命令提供判定（见「AI 内容校验」）。官网代码不参与本模块开发。

## 安装与环境

非视觉功能保留 Node.js >=20；视觉模块要求 >=20.3。浏览器和图片库按需加载，安装 npm 包和启动 MCP 不下载浏览器。显式安装固定浏览器：

```sh
tianshu-mcp visual browser install
tianshu-mcp visual doctor /path/to/project
tianshu-mcp visual init /path/to/project
```

固定依赖为 puppeteer-core 24.43.1、@puppeteer/browsers 2.13.2、sharp 0.34.5、pixelmatch 7.2.0。安装器从 Puppeteer 的 revision 映射读取浏览器版本。浏览器缓存位于 MCP 数据目录的 `browsers`。缺少可选 sharp 时执行 `npm install --include=optional`；缺失依赖不会阻止旧 MCP 功能启动。

Windows 10 x64 本机最小启动与截图已验证：Windows 10 Pro 10.0.19045、Node 24.18.0、Chrome 148.0.7778.97，2026-09-14。macOS 13+ Intel/Apple Silicon 和其他 Node 版本的真实视觉证据尚待验证，不能据此宣称全部兼容性验收完成。完整验证记录见 [验证进度](visual-validation.md)。

## 项目配置

编辑 `.tianshu-mcp/acceptance.json`。`init` 合并一个禁用的模板并保留原配置；已有 visual 时拒绝覆盖。配置不存在时沿用默认命令推导；存在但 JSON/schema 无效时阻塞。省略 `checks` 继续推导命令，显式 `checks: []` 才关闭命令配置。`extraChecks` 和 `checksMode=replace` 不覆盖视觉门禁。默认 `requireChanges: true`；只验收已有产物可显式设为 false。

```json
{
  "checks": [],
  "requireChanges": false,
  "visual": {
    "enabled": true,
    "browser": { "mode": "managed" },
    "viewports": [{ "id": "desktop", "width": 1280, "height": 720, "deviceScaleFactor": 1 }],
    "pages": [{
      "id": "home", "source": { "type": "static", "root": "public" },
      "route": "/index.html", "readySelector": "main",
      "maskSelectors": ["[data-visual-dynamic]"], "steps": []
    }],
    "images": [{ "id": "cover", "files": ["output/cover.png"], "formats": ["png"],
      "width": { "exact": 1200 }, "height": { "exact": 630 }, "fileSizeBytes": { "max": 2097152 } }]
  }
}
```

`visual` 严格拒绝未知字段、重复 ID、空规则及冲突参数。规则默认必需，显式 `optional: true` 降为告警；配置、屏蔽规则完整性、基准完整性错误仍然阻塞。

| 字段 | 配置 |
|---|---|
| browser | `{mode:"managed"}`；`chrome`/`edge` 可选 executablePath；`executable` 必须指定 executablePath |
| baselineRoot | 默认 `tests/visual/baselines`，项目相对路径 |
| viewports | id、width、height、deviceScaleFactor；默认 desktop 1280×720 和 mobile 390×844，DPR=1 |
| defaults | capture=viewport、pixelThreshold=0.1、maxDiffRatio=0.001、locale=en-US、timezone=UTC、colorScheme=light；element 需要 selector |
| limits | concurrency=1（1～4）；serviceTimeoutMs=60000；navigationTimeoutMs=30000；itemTimeoutMs=60000；roundTimeoutMs=300000 |
| limits（容量） | stabilitySamples=3（2～3）；inputBytes=20971520；decodedPixels=32000000；artifactBytes=524288000 |
| allowedOrigins | 精确 HTTP/HTTPS/WS/WSS origin，无路径；默认空 |

三个互斥页面来源：

```json
{ "type": "existing", "url": "http://127.0.0.1:4173" }
```
```json
{ "type": "command", "command": "npm", "args": ["run", "preview", "--", "--port", "4173"], "cwd": ".", "env": { "TEST_TOKEN": "VISUAL_TEST_TOKEN" }, "readyUrl": "http://127.0.0.1:4173" }
```
```json
{ "type": "static", "root": "public" }
```

以上端口和命令仅为项目示例。command 需要显式端口，不复用已占用端口；env 的值是环境变量名称，不是秘密原文。static 默认随机端口，不提供目录列表并拒绝越界路径和符号链接。existing 不管理已有进程。服务按定义在同轮复用，浏览器为独立临时实例。

页面还可设置 viewports（ID 列表）、capture（viewport/fullPage/element）、selector、pixelThreshold、maxDiffRatio、storageState、baseline（显式共享参考路径）。默认基准按 `<baselineRoot>/<platform>/<browserKind>/<caseId>/<viewportId>.png` 分隔环境。

声明式 steps：click/input/hover 使用 selector，input 还需 value；scroll 使用 selector 或 x/y；wait 在 selector、url、durationMs 中选一，selector 可带 visible/hidden 的 state。禁止任意 JavaScript 准备脚本。整页截图有界滚动触发懒加载；等待字体与图片、关闭动画、应用屏蔽后要求相邻两次截图一致。缺失屏蔽区域、全图屏蔽、页面不稳定和网络资源拦截不能通过。

storageState 是项目相对 JSON 文件，结构为 `cookies: [{name,value,domain,path,expires,httpOnly,secure,sameSite}]` 和 `origins: [{origin,localStorage:[{name,value}]}]`。仅导入测试账户状态，报告不复制 Cookie/localStorage 内容。

图片 files 必须显式列出。仅支持静态 PNG/JPEG/WebP；格式必须与扩展名匹配并完成解码。width、height、aspectRatio、fileSizeBytes、dpi 使用 exact 或 min/max；transparency 为 transparent（至少一个真实透明像素）或 opaque。缺少 DPI 元数据记为未知，配置 DPI 要求时失败。方向归一后比较宽高。缺失、损坏、规格错误可返修；读取权限、依赖、容量不足阻塞。

颜色阈值是 pixelmatch 参数；差异比例为不同像素数除以未屏蔽像素数，`<= maxDiffRatio` 通过。抗锯齿差异默认排除，尺寸不同直接失败，不缩放。输出差异图、区域标注图、最大 100 个连通区域与总体包围框。

## 基准与审批

准备请求 JSON：

```json
{ "projectPath": "/path/to/project", "caseIds": ["home"], "viewportIds": ["desktop"] }
```

可加 `imports: [{caseId,viewportId,file}]` 从项目内 PNG/JPEG/WebP 导入。候选保存在 MCP 数据目录，返回 candidateId、digest、preview。先查看预览再明确批准：

```sh
tianshu-mcp visual baseline prepare prepare-request.json
tianshu-mcp visual baseline approve approve-request.json
```

批准 JSON 为 `{candidateId,expectedDigest,approvalNote,taskId?}`。可选 taskId 只能是同项目的 needs_attention 任务。摘要、原基准、规则或项目不匹配会拒绝。被 Git 忽略的目标也拒绝，不强制添加、不改忽略文件。MCP `prepare_visual_baseline`/`approve_visual_baseline` 接收相同 JSON；两者是有副作用操作，宿主必须执行授权控制。自动返修禁止批准基准。

任务动工前冻结规则及基准摘要，每轮检查前后核对。规则变动需要独立审阅：

```sh
tianshu-mcp visual rules review TASK_ID
tianshu-mcp visual rules approve TASK_ID REVIEW_ID DIGEST "用户确认的批准说明"
```

基准/环境阻塞进入 needs_attention，并保留待重新验收标记。处理后 rework_task 先验收，通过则结束，仍阻塞则等待；只有真实缺陷才进入返修。

## AI 内容校验（可选，默认关闭）

校验图片或页面截图**内容**是否符合用户显式声明的期望描述（如「Logo 含蓝色齿轮与文字 TIANSHU」、
「存在用户名与密码输入框及登录按钮」）。与像素/规格检查平行，作为独立结果项 `kind:"content"` 进入统一报告。

**凭证零管理**：MCP 不读取、不存储、不转发任何密钥，也不实现模型/厂商 HTTP 客户端。判定完全委托给
用户自备的本地命令，由该命令自己使用它的登录态或密钥。详见 [SECURITY.md](../SECURITY.md)。

### 配置

```json
{
  "visual": {
    "enabled": true,
    "content": {
      "enabled": true,
      "command": "vision-cli",
      "argsTemplate": ["judge", "--image", "<image:path>", "--expect-file", "<expect:file>"],
      "cwd": ".",
      "env": { "VISION_API_KEY": "MY_VISION_KEY" },
      "allowRemote": false,
      "samples": 3,
      "timeoutMs": 90000,
      "minConfidence": 0.6,
      "cache": true
    },
    "contents": [
      { "id": "logo-elements", "files": ["assets/logo.png"], "expect": "Logo 含蓝色齿轮图形与白色文字 TIANSHU" }
    ],
    "pages": [
      { "id": "home", "source": { "type": "static", "root": "dist" }, "route": "/" },
      {
        "id": "login-semantic",
        "source": { "type": "static", "root": "dist" },
        "route": "/login",
        "pixel": false,
        "content": { "expect": "存在用户名与密码输入框及登录按钮", "blocking": true }
      }
    ]
  }
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| content.enabled | `false` | 总开关；声明了任何内容规则却不启用会被 schema 拒绝 |
| content.command | — | 自备判定命令；逐规则可用 `command` 覆盖，两者都缺则拒绝 |
| content.argsTemplate | — | 参数模板（见占位符表）；逐规则可覆盖 |
| content.cwd | 项目根 | 项目相对路径 |
| content.env | `{}` | `{ 子进程变量名: 宿主环境变量名 }`，缺失宿主变量 → 整轮阻塞（`CONTENT_ENV_MISSING`） |
| content.allowRemote | `false` | 默认禁止外发；逐规则可覆盖 |
| content.samples | `3` | 单次判定采样次数（1～9），多数票 |
| content.timeoutMs | `90000` | 单项命令超时；硬约束 `samples × timeoutMs ≤ limits.roundTimeoutMs`，违反即配置期拒绝 |
| content.minConfidence | 省略 | 省略即关闭置信度闸门（见下方语义） |
| content.cache | `true` | 任务目录级判定缓存 |
| contents[].id / files | — | 规则 ID 与图片项目相对路径列表（大小写不敏感去重） |
| contents[].expect | — | 期望描述（必填，1～4000 字符）；不从任务文本自动推导 |
| contents[].blocking | `false` | `false` 映射为 `optional:true`（仅告警）；`true` 才参与致败与返修 |
| pages[].pixel | `true` | `false` 表示语义-only：跳过像素对比与基准要求（必须声明 `content`） |
| pages[].content | — | 页面级内容校验，复用同一次截图，派生 id 为 `<pageId>-content` |

### 命令契约

- **占位符**（未在模板中出现的占位符不会生成对应临时文件）：

| 占位符 | 展开为 | 附加条件 |
|---|---|---|
| `<image:path>` | 被检图片的绝对路径（经项目路径闸门） | — |
| `<expect:file>` | 写入 UTF-8 期望原文的临时文件绝对路径 | — |
| `<image:base64:file>` | 写入该图片 base64 的临时文件绝对路径 | **必须**该规则有效 `allowRemote === true`，否则 schema 拒绝 |

  出现任何其他 `<...>` token 直接拒绝配置。

- **stdout**：取**最后一行非空文本**解析 JSON：`{ "passed": boolean, "confidence"?: 0..1, "reason": string }`（严格模式，未知字段拒绝）。
- **退出码**：`0` 表示命令正常执行（**不代表判定通过**，通过与否看 JSON）；非 `0` 表示命令执行失败。
- 期望描述经临时文件传递，既规避命令行转义与长度上限，也避免期望文本进入进程命令行。
- 临时输入文件每轮采样后在 `finally` 中删除（属易失输入，不计入产物体积）。

### 判定与防抖

- 单项内**串行**采样（项间仍受 `limits.concurrency` 约束），避免同一命令并发抢占与输出交错。
- 多数票：通过票 > `samples/2` 判 `CONTENT_MATCH`；不通过票 > `samples/2` 判 `CONTENT_MISMATCH`；否则 `CONTENT_UNCERTAIN`。
- `confidence` 取已给出置信度的投票的算术均值；命令不报置信度则不参与任何闸门。
- **`minConfidence` 在命令不报 confidence 时不生效**：该行为是刻意的（对不输出置信度的命令设默认值会把全部
  判定误伤成不确定），但此时报告 md 与离线 HTML 会明确标注「命令未提供 confidence，minConfidence 未生效」。
- **任何一次命令级失败（非零退出/超时/输出非法）→ 该项直接判 blocked**，不把基础设施故障混进「不确定」。
- 缓存键为输入哈希，纳入图片内容摘要、期望文本、命令字符串、**命令绝对路径与二进制摘要**（自备 CLI 升级后旧判定
  自动失效）、参数模板、cwd、已解析环境值摘要（不落明文）、`allowRemote`、`samples`、`minConfidence`。
  命令身份无法可靠计算时**不做缓存**。仅成功完成的判定入缓存，blocked 不入缓存；缓存只存期望文本摘要而非原文。
- 缓存位置 `<taskDir>/visual-content-cache/`。命中缓存时不调用命令，结果标 `cached: true`。
- 逃生门：`content.cache: false` 关闭；`tianshu-mcp visual content cache clear <taskId>` 清理。

### 原因码

| 原因码 | status | 可返修 | 触发条件 |
|---|---|---|---|
| `CONTENT_MATCH` | passed | 否 | 多数票判定满足期望 |
| `CONTENT_MISMATCH` | failed | 是 | 多数票判定不满足期望 |
| `CONTENT_UNCERTAIN` | uncertain | 否 | 票不集中，或有效置信度低于 `minConfidence` |
| `CONTENT_COMMAND_MISSING` | —（整轮） | — | 任一规则的**有效**命令无法解析/不可执行 → 整轮 `configurationError`，不产出结果行 |
| `CONTENT_COMMAND_FAILED` | blocked | 否 | 命令退出码非 0（单项） |
| `CONTENT_TIMEOUT` | blocked | 否 | 单项超时（单项） |
| `CONTENT_OUTPUT_INVALID` | blocked | 否 | stdout 末行缺失/非 JSON/字段不合法（单项） |
| `CONTENT_ENV_MISSING` | —（整轮） | — | 声明的宿主环境变量缺失 → 整轮 `configurationError`，不产出结果行 |
| `CONTENT_CONFIG_INVALID` | blocked | 否 | 运行期兜底（正常应由 schema 拦截） |

`CONTENT_COMMAND_MISSING` 与 `CONTENT_ENV_MISSING` 走整轮预检抛错路径：**不产出任何结果行**，只出现在
`blockingIssues`。这是 fail-closed 的有意设计——启用后依赖缺失绝不静默当成通过。

### 告警、不确定与门禁

- 内容项默认 `blocking:false` → `optional:true`，**仅告警**：不改变 verdict，不触发返修。
- 逐规则 `blocking:true` 才纳入致败（`visualFailed`/`visualBlocked`）与返修计划。
- `uncertain` 既不匹配 `failed` 也不匹配 `blocked`，**天然不参与 verdict、不触发返修**。
- 告警与不确定必须可见：整轮 message 会出现「AI 内容判定不确定（仅告警）: ...」与
  「AI 内容告警未通过（不影响结论）: <id> [<code>]」；返修计划把它们列入「仅告警项（不必修复）」，
  并明确要求不得为消除告警而伪造产物或放宽检查。

### 成本边界（本版唯一约束）

不设判定次数或金额的独立上限。成本完全取决于：① 规则数 × 采样数（用户显式声明，`samples` 有 `≤ 9` 上界）；
② `limits.roundTimeoutMs` 总闸；③ 缓存（同输入零重跑）。`visual doctor` 会按
`规则数 × 采样数 × timeoutMs` 与 `roundTimeoutMs` 对比给出建议值（不自动修改配置）。启用内容校验时通常需要
上调 `limits.roundTimeoutMs`。

### 数据外发声明

图片是否离开本机取决于**用户自备命令的行为**，MCP 无法在系统层拦截。MCP 的强制力仅在契约层：未显式放行
`allowRemote` 的规则禁止使用 `<image:base64:file>`（schema 拒绝）。`visual doctor` 列出各规则的 `allowRemote`
声明。请自行确认命令的实际行为。

### 验证自备命令

```sh
tianshu-mcp visual content probe /path/to/project [ruleId]
```

按声明规则跑一次真实判定但**不写证据、不写缓存**，打印原始票型与命令解析结果，便于先确认命令可用、判定稳定。
`visual doctor` 另会逐条报告有效命令的解析结果与 `allowRemote` 声明。

## 报告与保留

每轮目录为 `<home>/tasks/<taskId>/visual/<reportRound>`。自动、手动验收使用互斥轮次分配，保留历史。report Markdown/JSON 增加独立 visual，HTML 提供状态过滤、图片并排、透明叠加、指标与区域坐标，不使用 CDN。

```sh
tianshu-mcp visual artifacts clean TASK_ID
tianshu-mcp visual artifacts clean TASK_ID --apply
```

默认仅预览，apply 只删除指定任务的视觉目录，保留报告和清理标记，不删正式基准。超过预算时阻塞，不删除旧证据换取通过。CLI 在 MCP stdio 连接前分流。

## 排查

| 现象 | 处置 |
|---|---|
| 页面时间、随机文案或轮播导致每轮都差异 | 用 `maskSelectors` 显式屏蔽动态区域；不要调大阈值掩盖真实回归。屏蔽不到或全图屏蔽会直接阻塞 |
| 整页截图尺寸每轮变化（懒加载、无限滚动） | 页面持续扩张属于阻塞；补就绪条件或收敛内容，不要放宽 `maxDiffRatio` |
| 外部字体/图片/接口被拦截 | 在 `allowedOrigins` 精确放行来源后再验收；残缺页面不会判通过 |
| 跨系统/换机后基准不匹配 | 基准默认按 `<platform>/<browserKind>` 分区；为新环境准备并批准候选，不要共用他机基准 |
| 换浏览器版本后整体偏移 | 基准 manifest 记录浏览器完整版本；升级后重新准备候选并走批准流程 |
| 阈值怎么理解 | `pixelThreshold` 是 pixelmatch 颜色容差，`maxDiffRatio` 是允许的最大差异比例；抗锯齿差异默认已排除 |
| 缺基准导致不通过 | 缺基准只能生成候选，必须用户审阅后批准；自动返修不会批准 |
| needs_attention 的视觉阻塞 | 先处理环境或审批，再 `rework_task`；系统会先重新验收，只有真实缺陷才启动 agent |

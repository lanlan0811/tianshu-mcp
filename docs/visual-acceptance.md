# 视觉验收（开发中，目标 v0.5.0）

[English](visual-acceptance.en.md)

视觉验收复用 `run_task`、`verify_task`、`get_task_report`、`query_task` 和 `rework_task`，支持客观页面截图对比与静态图片规格检查。没有 AI 内容或风格判断。官网代码不参与本模块开发。

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

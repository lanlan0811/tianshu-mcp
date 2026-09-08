# v0.1.5 发布说明

- 发布日期：2026-09-08
- 版本：`tianshu-mcp@0.1.5`
- 许可证：Apache-2.0
- 英文版：[release-v0.1.5.en.md](release-v0.1.5.en.md)

---

## 亮点

### 1. TraeWork 面板模式切换（新功能）

`run_task` 新增可选参数 `mode`，支持 `Work` / `Code` / `Design`：

```jsonc
run_task({
  "projectPath": "D:/xxx/my-app",
  "agentId": "traework",
  "task": "切换到 Code 模式，实现登录接口",
  "model": "GLM-5.3",
  "mode": "Code",          // 可选：显式指定
  "autoVerify": true,
  "autoFixRounds": 2
})
```

解析优先级：**显式 `mode` 参数 > 任务书文本识别 > 保持 `Work`**。
文本识别覆盖中英混写（「切换到 Code 模式」「用 Design 模式」「工作模式」「代码模式」「设计模式」等）。

**实测关键发现**：TraeWork 的三种模式**各自维护独立的项目绑定**，切换模式会把输入栏项目换成该模式上次使用的项目。因此执行顺序调整为：

```text
确保实例可用 → 等待 UI 就绪 → 新建会话 → 切换到目标模式 → 在目标模式内绑定项目 → 切模型 → 发送任务 → 轮询到完成
```

绑定后会复核「模式 + 项目」双双就位，任一不符即**响亮失败**（不静默在错误模式下开发）。

真机验证（2026-09-08）：`mode=Code` 与 `mode=Design` 均完成「切换模式 → 绑定项目 → 发送 → 生成文件 → 自动验收通过」。

### 2. README 重写（中英双语）

- 新增专属 **SVG 应用图标**（`assets/tianshu-mcp-icon.svg`，天枢中枢星 + 三个 agent 节点）
- 新增 **SVG 长方形横幅**（`assets/tianshu-mcp-banner.svg`，1280×320），位于图标上方
- 两份 README 均加入技术栈勋章：CI、npm 版本/下载量、License、TypeScript、Node ≥ 20、MCP SDK
- 语言隔离：`README.md` 只引用中文文档；`README.en.md` 只引用英文文档

### 3. 许可证统一

`package.json` 的 `license` 由 `MIT` 改为 `Apache-2.0`，与仓库内 `LICENSE` 文件（Apache License 2.0 全文）保持一致。

---

## 变更清单

| 类型 | 内容 |
|---|---|
| 新增 | `run_task` 的 `mode` 参数（Work/Code/Design） |
| 新增 | `gui.modeSwitch` profile 开关（默认 `true`） |
| 新增 | `detectModeFromText` / `resolveMode` 纯函数（可单测） |
| 新增 | `assets/tianshu-mcp-icon.svg`、`assets/tianshu-mcp-banner.svg` |
| 新增 | `scripts/probe-traework.mjs mode <Work\|Code\|Design>` 子命令 |
| 变更 | TraeWork 执行顺序：绑定项目改为在目标模式内进行 |
| 变更 | meta 块新增 `model` / `mode` 字段，便于天枢回读 |
| 变更 | `package.json`：version 0.1.5、license Apache-2.0、新增 repository/homepage/bugs、files 增加 `assets` |
| 变更 | README.md / README.en.md 全量重写 |
| 文档 | `docs/traework-cdp.md`/`.en.md` 补充模式切换；`docs/agent-profiles.md`/`.en.md` 补充 `gui.modeSwitch` |

## 测试

| 项 | 结果 |
|---|---|
| 单元 + 集成 + 协议 | **167/167 通过**（v0.1.4 为 153，新增 14 项模式相关用例） |
| lint / typecheck / build | 全绿 |
| CI（ubuntu/windows/macos × Node 20/22 + tarball 检查） | 全绿 |
| 真机端到端 | `mode=Work` / `mode=Code` / `mode=Design` 均通过 |

## 升级指引

```bash
npm install -g tianshu-mcp@0.1.5
# 或在 npx 模式下由天枢自动拉取最新版
```

驱动 TraeWork 时若需指定面板模式：

```text
run_task(projectPath=..., agentId=traework, task=..., mode=Code)
```

## 已知限制

- `mode` 仅对 GUI 类 agent（`traework`）生效，CLI 类 agent（`codex`）忽略该参数。
- TraeWork 窗口需保持可见（发送依赖模拟输入）。
- TraeWork UI 升级可能改变选择器；可用 `scripts/probe-traework.mjs` 诊断，并在 profile 的 `gui.selectors` 中覆盖。

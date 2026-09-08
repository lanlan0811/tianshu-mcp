# v0.1.6 发布说明

- 发布日期：2026-09-08
- 版本：`tianshu-mcp@0.1.6`
- 许可证：Apache-2.0
- 英文版：[release-v0.1.6.en.md](release-v0.1.6.en.md)

---

## 本次修复：项目文件夹绑定卡住

实战反馈：选择「项目文件夹」时卡住不动，没有按项目路径跳转并点击「选择文件夹」。
排查结论：**适配器没有坏，是原生对话框链路的三处缺陷叠加**（实测证据见下）。

### 缺陷 1：点击 footer 未确认对话框是否弹出
旧实现只看 `element.click()` 的返回值就认为点击成功；但该按钮点击后原生弹窗可能并未出现。
日志里「等待原生『选择文件夹』对话框超时」是**下游症状**，不是根因。

**修复**：点击后调用 `findFolderDialog()` 确认对话框真的出现；未出现则记录当前下拉 DOM 快照
并明确失败（便于定位选择器漂移）。

### 缺陷 2：检测预算被 PowerShell 冷启动吃光
实测：PowerShell 进程冷启动 **4.5–6.3s/次**（与用 UIA 还是 Win32 探测无关）。
旧实现在 Node 侧每 800ms 轮询一次 → **15s 预算只够约 2 次探测**，TraeWork 稍慢就必然超时。

**修复**：改为**单次 PowerShell 调用内轮询**（脚本内 400ms 间隔），预算 15s → **30s**；
同时把 `spawnSync` 换成异步 `spawn`，不再阻塞事件循环。

### 缺陷 3：中文路径被控制台代码页破坏
实测：`D:\Trae项目\ts-bind-test` 经 SendKeys/剪贴板写入后变成 `D:Traes-bind-test`
（CJK 与反斜杠被吞），导致「路径写进去了但选中的是别的目录」。

**修复**：改用 Win32 **`WM_SETTEXT`**（句柄由 UIA 提供）直接写编辑框，CJK 路径完全可靠。

### 附带修复

- **确认按钮点到了文件列表项**：`AutomationId="1"` 不唯一（列表行也用 0/1/2…），
  改为 **AutomationId=1 且 ControlType=Pane** 组合定位后再按矩形坐标点击。
- **PowerShell 中文输出乱码**：脚本内只用 ASCII 输出，Node 侧 `localizeDialogMessage()` 映射回中文。
- **非 Work 模式绑定兜底**：Code/Design 模式绑定失败时自动**回落 Work 重试一次**，
  成功后再切回目标模式并复核项目仍在；两次都失败才报错（错误信息含两种模式各自原因）。

---

## 真机验证

对**不在下拉列表**的新项目执行全链路：

```text
run_task(projectPath=D:\Trae项目\ts-bind-test, agentId=traework, mode=Code, autoVerify=true)
```

结果：

| 步骤 | 结果 |
|---|---|
| 切到 Code 模式 | ✅ |
| 下拉未命中（下拉 12 项不含该项目） | ✅ 走原生对话框 |
| 原生对话框弹出并被检测 | ✅ |
| 写入 CJK 路径 + 点击确认 | ✅ 对话框关闭 |
| 项目进入 TraeWork 列表 | ✅ `solo-lite.local-project-folders` 22 → 23 条 |
| 发送任务 | ✅ TraeWork 创建 `result.txt` |
| 自动验收 | ✅ `succeeded`（1/1 检查通过） |

## 变更清单

| 类型 | 内容 |
|---|---|
| 修复 | footer 点击后确认对话框出现；检测改为单次 PS 内轮询（30s 预算）；`WM_SETTEXT` 写 CJK 路径；确认按钮按 id+Pane 定位；ASCII-only 输出 |
| 新增 | 非 Work 模式绑定失败回落 Work 重试 |
| 文档 | `docs/traework-cdp.md` / `.en.md` 踩坑表新增 7 条 + 兜底说明 |
| 测试 | 167 → **172**（对话框消息映射/平台分支单测 + Code→Work 兜底集成测试） |

## 已知限制

- 该链路依赖 Windows 原生对话框，**窗口必须可见**且不能有第三方工具（如截图器）抢焦点。
- 项目文件夹绑定成功后，TraeWork 会把它记入自己的项目列表，后续任务可直接命中下拉。
- macOS 分支仍为 fail-closed（未验证）。

## 升级

```bash
npm install -g tianshu-mcp@0.1.6
```

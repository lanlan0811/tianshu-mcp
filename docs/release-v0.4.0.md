# tianshu-mcp v0.4.0 发布说明

在 macOS 上打通 `codex` 与 `zcode` 两条 GUI 驱动，新增 `projectPath` 安全闸门，并落地一批消除事件循环冻结与测试套件提速的工程改动。

> 本次变更来自社区贡献者 PR [#11](https://github.com/lanlan0811/tianshu-mcp/pull/11)（13 + 4 个提交），由维护者完成与 `master` 的冲突收口与 Windows 平台缺陷修复后合并。

## 新增

- **Codex GUI 驱动支持 macOS**：直接 spawn `ChatGPT.app` 包内可执行（`activation` 按平台默认 `spawn`/`msix-com`），`detached+unref` 实例驻留；POSIX 进程枚举与 SIGTERM 停止；darwin 安装发现默认目录；项目登记状态文件跨平台直写；运行观察环对 renderer 瞬时无响应与 target 替换做 CDP 重连。
- **ZCode GUI 驱动支持 macOS**：适配主进程标题改写（argv 隐藏后端口归属放宽 + 配置端口段有界补扫）；文件夹面板按 macOS 窗口形态重写（NSOpenPanel 独立窗口 + go-to 字段 AX 直写，免疫中文输入法截获）；新建任务惰性按钮回退侧栏大按钮。
- **`projectPath` 安全闸门**：提交即校验——绝对路径 + 存在目录 + `realpath` 消除符号链接（回执明示解析来源）；拒绝用户主目录本身与系统/根级目录（含 macOS `/private/*` realpath 形态）；git 仓库有未提交变更时追加共处警示。
- **macOS 无头路径（用户 profile）**：内置 `codex` 仍走 GUI 驱动；不想依赖 GUI 自动化时，可在数据目录加一个 `driver=spawn` 的 `codex-cli` profile 走 `codex exec`。⚠️ codex CLI 请保持最新：≤0.130.0 的签名证书已被吊销，macOS Gatekeeper 会直接 SIGKILL，需 ≥0.154.0。详见 README 的「macOS 无头路径：codex-cli」。

## 升级注意（行为变更）

- **验收命令默认并行**：新增 `verifyConcurrency`（范围 1–4），**默认值由串行变为 2**。检查项之间有顺序依赖时（例如后续检查读取 build 产物、带 `--fix`、共享缓存目录），请显式设为 `1` 以完全退化为串行；项目级 `.tianshu-mcp/acceptance.json` 可覆盖。报告与日志格式不变（按声明顺序拼接）。
- **项目身份改为 `realpath` 归一后的路径**：符号链接入口（如 macOS `/tmp` → `/private/tmp`）下，同一目录可能与此前的 `projects.json` 记录、历史任务目录不再匹配。如遇历史任务"看不到"，按规范化后的真实路径查找。
- **发布包不再包含 `.d.ts`**：`tsconfig.build.json` 关闭 `declaration`，dist 文件数 140 → 71。该包未声明 `types` 字段、`exports` 仅暴露运行时代码，对消费者的实际影响很小。

## 修复

- 修复 Windows 上 **盘符根未被安全闸门拦截**：`normPath` 会剥掉尾斜杠（`D:\` → `d:`），与拒绝清单中的 `d:/` 永不相等；改为单独的盘符根判定。
- 修复 `normalizeProjectPath` 的符号链接歧义（macOS `/tmp` → `/private/tmp` 曾使路径匹配退化为名称匹配，误报 `project_ambiguous`）。
- 修复 zcode macOS 面板失败的 `needsPermission` 误报（脚本字面量中的 `ACCESSIBILITY_PERMISSION_REQUIRED` 把一切失败报成权限问题）。
- 修复 `get_profiles` 不显示数据目录中用户自定义 profile（`run_task` 却可用，探测反馈不一致）。
- 修复取消用例与集成测试桩的偶发/隔离问题（`acceptance-parallel` 取消点改为确定性；`zcode-flow` 测试桩补 `listDialogs`）。
- CDP `connect()` 失败分支自清理 WebSocket；`send()` 超时定时器 `unref`。

## 性能

- `execFileSync`/`spawnSync` 全量异步化 + 进程枚举 1.5s TTL 缓存——消除 Windows 轮询期事件循环冻结（单次最坏 30s）。
- 验收命令检查有界并行（见上文 `verifyConcurrency`）。
- git 基线哈希两遍并一遍；代码分析每文件只读一次；`get_profiles` 与任务快照读并行。
- 测试套件 267s → 51s（UI 层 sleep 改依赖注入，vitest 拆 unit 并行 / integration 串行双 project；**443 项测试**）。

## 平台与验证状态

- **Windows 10 x64**：三平台 CI 矩阵中的 Windows job 全绿；维护者本地全量 **443/443** 通过。
- **macOS**：`codex` 与 `zcode` 的**基本闭环**由贡献者在 macOS arm64（ZCode 3.11.2 / ChatGPT.app 26.901.51231）真机验证；**取消 / 返修 / `continue_task` / 新建项目矩阵未覆盖，两者 darwin 仍保持 `research`**。
- 维护者**无 macOS 设备**，上述 macOS 真机结论未独立复验——仅按其提交的验证记录与文档采信。

## 分发与兼容性

- 已发布 GitHub Release 与 tarball，并同步发布到 npm（`tianshu-mcp@0.4.0`，`latest`）。GitHub 为主仓库，Gitee 为代码与标签镜像。
- 本版本为 **MINOR**：含新能力与上述行为变更（0.x 语义下 MINOR 即承载破坏性变更位，与 v0.2.0 / v0.3.0 的用法一致）。升级前请阅读「升级注意」。

相关文档：[ZCode 使用说明](zcode-cdp.md)、[Codex 桌面端驱动](codex-gui-cdp.md)、[配置说明](agent-profiles.md)、[验收配置](acceptance-config.md)、[变更日志](../CHANGELOG.md)。

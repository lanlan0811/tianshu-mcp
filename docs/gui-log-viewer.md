# Tianshu-mcp 日志台（GUI）

英文版：[gui-log-viewer.en.md](gui-log-viewer.en.md)

Tianshu-mcp 日志台（英文名 **Tianshu-mcp Logs**）是一个**本地只读**的桌面应用，把天枢 MCP 落盘的四类日志与任务产物统一到一个界面里查看。它**不依赖 MCP server 在运行**，直接读文件系统。

- 代码位置：`mcp-gui/`（独立工程，独立版本号，独立 CI）
- 技术栈：Tauri 2.x（Rust 后端）+ Vue 3 + Vite + TypeScript
- 与 MCP 主包的关系：**只读消费方**，不替代 `query_task` / `get_task_report`（那两个面向机器与天枢），也不改动任何业务数据

---

## 一、安装

产物来自 CI（GitHub Actions 的 `GUI` workflow）：

- **正式使用**：从 GitHub 或 Gitee 的 **pre-release**（tag 形如 `gui-v0.1.0-beta.1`）下载安装包；
- **尝鲜 / 验证**：从对应提交的 Actions 运行页下载 `gui-*` workflow artifact。

| 平台 | 安装包 | 自动更新载体 |
|---|---|---|
| Windows | `.exe`（NSIS 安装器） | NSIS 产出的 `.nsis.zip`（**Tauri updater 不支持 MSI**，故未提供 MSI） |
| macOS | `.dmg` | `.app.tar.gz` |

> **macOS 未做 Apple 代码签名与公证**：首次打开可能需要在「系统设置 → 隐私与安全性」中手动允许。
> 这不影响功能，也不影响自动更新——更新包的完整性由 minisign 签名校验保证。

---

## 二、数据目录

应用启动时按与 MCP server **完全相同的规则**解析默认数据目录：

1. 环境变量 `TIANSHU_MCP_HOME`（非空即用）；
2. 否则 `~/.tianshu-mcp`。

顶栏可：

- 在多个数据目录之间**切换**；
- **追加**目录（校验规则：目录下必须存在 `logs/` 或 `tasks/`，否则明确拒绝并给出原因）；
- **移除**已追加的目录。

追加的目录列表持久化在**系统应用配置目录**（如 Windows 的 `%APPDATA%`、macOS 的 `Application Support`），**不写入项目目录**。

---

## 三、四类日志

| 数据源 | 路径（相对数据目录） | 界面位置 |
|---|---|---|
| 全局运行日志 | `logs/server.log` | 「运行日志」标签页 |
| 任务事件流 | `tasks/<taskId>/task.jsonl` | 「事件流」标签页 |
| 原始执行日志 | `tasks/<taskId>/agent-<轮次>.log`、`verify-<轮次>.log` | 「Agent 日志」/「验收日志」标签页 |
| 验收报告 | `tasks/<taskId>/report-<轮次>.{md,json,html}`、`dry-run-report-<轮次>.{md,json}` | 「验收报告」标签页 |

### 3.1 任务列表

- 默认按更新时间倒序；支持按**项目 / Agent / 状态 / 时间范围**筛选，按更新时间 / 创建时间 / 任务 ID 排序；
- 状态色标：`queued/running/verify_start/fixing` 为活动态，其余为终态；显示已用轮次与最近报告轮次；
- 同时覆盖 `tsk_*`（派单任务）与 `vfy_*`（独立路径验收记录）。

### 3.2 事件流

- 解析 `task.jsonl` 为时间线，**区分状态跃迁事件与细粒度 Agent 事件**（`task_dispatched` / `confirmation_dialog_detected` / `awaiting_user_authorization` / `file_modification_started` / `rework_triggered`）；
- `note` 事件仍是**进度 / 审计通道**，界面单独标注，不与语义事件混为一谈；
- `file_modification_started` 是**启发式推断**（适配器并不直接观测文件系统），文案如实保留「可能开始改动文件」；
- 无法解析的坏行**跳过但计数**并在顶部明确提示，不静默丢弃。

### 3.3 原始日志

- 首屏只读**尾部窗口**（64 KiB），向前按块加载，并显示「已加载 N / 共 M」；
- 级别过滤（`DEBUG/INFO/WARN/ERROR`）、关键字高亮、行号与自动换行开关；
- **实时跟随**：文件被追加时自动增量刷新；**手动向上翻阅会自动暂停跟随**（不会被强行拉回底部），右下角显示状态，可一键「跳到最新」。

### 3.4 验收报告

- `report-<轮次>.md`：Markdown 渲染；
- `report-<轮次>.json`：结构化卡片（检查项通过 / 失败 / 跳过、耗时、退出码、输出尾部、`changedFiles`、`diffstat`、`analysis.signals`、阻塞问题）；
- `report-<轮次>.html`（视觉验收）：在 **sandbox iframe** 中渲染——**禁用脚本、注入 CSP 阻断一切外部资源、不联网**；
- `dry-run-report-*` 与 `report-*` **分开展示**（两者结论口径不同：静态分析 vs 真实命令验收）；
- 多轮报告可并排**对比**。

---

## 四、跨任务搜索 / 导出 / 复制

### 4.1 全局搜索

- 范围可选：事件流 / Agent 日志 / 验收日志 / 验收报告 / 运行日志；
- 结果按「任务 → 文件 → 行」分组，显示命中片段，点击即跳转到对应视图与位置；
- **按需扫描，不建本地全文索引**；带进度反馈且**可取消**。

### 4.2 导出

- **单文件导出**：导出当前查看的日志 / 报告原文；
- **任务整包导出**：把整个 `<taskId>/` 目录打成 zip，可选**排除体积大的原始日志**（`agent-*.log` / `verify-*.log`），被排除的文件数如实回报。

### 4.3 复制

任务 ID、任务目录绝对路径、当前日志全文，均可一键复制。

---

## 五、界面语言与主题

- **中英双语**可切换，默认中文；
- 主题三选一：**跟随系统 / 浅色 / 深色**，默认跟随系统。

---

## 六、双源自动更新（Gitee / GitHub）

### 6.1 更新源如何选择

**主动实测，不依赖系统区域 / 时区**（VPN 场景下区域不可信）：

1. 检查更新时并发探测两个更新清单端点，按「可达性 + 延迟」择优；
2. 探测结果按 TTL 缓存，避免频繁探测拖慢启动；
3. 两端都不可达 → 回退**上次成功使用的源**；无历史则回退 GitHub，并明确提示降级；
4. 设置面板提供三态开关：**自动 / 强制 Gitee / 强制 GitHub**（默认自动），便于网络异常时自救。

| 源 | 清单端点 |
|---|---|
| GitHub | `https://raw.githubusercontent.com/lanlan0811/tianshu-mcp/master/update/gui/latest.json` |
| Gitee | `https://gitee.com/lan0811/tianshu-mcp/raw/master/update/gui/latest-gitee.json` |

典型现象：中国大陆网络命中 **Gitee**；境外（含中国香港、中国台湾）命中 **GitHub**。

### 6.2 签名与失败处理

- 更新包使用 **minisign 签名**，应用内置公钥校验，**验签不通过一律拒绝安装**（这是 Gitee 侧免遭中间篡改的底线）；
- 检查 / 下载 / 安装任一步失败都**不影响日志查看主流程**，设置面板同时给出「手动下载」入口；
- 更新通道与 **pre-release** 一一对应：GUI 全程定位为测试版。

### 6.3 未配置更新公钥时

若 CI 未配置 `UPDATER_PUBKEY`，安装包里保留占位公钥，应用会在设置面板明确提示「自动更新暂不可用」。此时安装包本身**仍然可用**，只是不能自动更新——手动下载覆盖安装即可。

---

## 七、本地开发与自行构建

### 7.1 只做前端预览（推荐）

前端可完全离线调试，**不需要 Rust 工具链**：

```bash
cd mcp-gui
npm install
npm run dev          # Vite 开发服务器（端口 1420）
```

不在桌面运行时时，`src/api/` 会自动切换到 **mock 数据出口**，数据来自 `mcp-gui/fixtures/`（真实日志样本，已脱敏），因此筛选、搜索、报告渲染、语言与主题等交互都能在没有后端的情况下完整验证。

前端质量门禁：

```bash
cd mcp-gui
npm run typecheck    # vue-tsc --noEmit
npm run lint         # eslint . --max-warnings 0
npm run test         # vitest run
npm run check:schema # TS 真源 ↔ 前端镜像 ↔ Rust 镜像 词表一致性
```

### 7.2 Rust / Tauri 侧一律在 CI 构建

按 issue #25 的硬约束：**开发机不执行 Rust 侧构建与检查**（`cargo fmt` / `clippy` / `tauri build` 全在 `GUI` workflow 完成）。这样做的原因是避免「本地环境绿、CI 红」的假信号。

CI 会依次执行：

1. `mcp-gui` 前端 `typecheck` / `lint` / `test`；
2. 用 `tauri icon` 从 `assets/tianshu-mcp-icon.svg` **生成图标**（仓库只保留 SVG 源）；
3. 从 `TIANSHU_UPDATER_PUBKEY` 注入更新公钥（可选）；
4. `cargo fmt --check` / `cargo clippy -- -D warnings` / `cargo test`；
5. `tauri build`（Windows 出 NSIS，macOS 出 dmg + `.app.tar.gz`）。

因此：

- `mcp-gui/src-tauri/icons/` 与 `Cargo.lock` **不入库**（由 CI 生成）；
- 想自行打包，请直接复用 CI 产物，或自行准备 Rust 工具链后在本机执行 `npx tauri build`（本项目不以此为验收依据）。

**实测状态（2026-09-27）**：`GUI` workflow 已跑通——`schema-parity` ✅，三平台 `cargo fmt --check` / `clippy -- -D warnings` / `cargo test` 全绿，
且**三平台（`windows-x86_64` / `darwin-x86_64` / `darwin-aarch64`）全部 success**，均完成 `tauri build` 打包并上传产物。
打包时若未配置签名密钥，workflow 会自动降级为 `--config '{"bundle":{"createUpdaterArtifacts":false}}'`：**安装包照常产出，自动更新不可用**（设置面板会明确提示）。

**手动触发（Actions 页的 `Run workflow`）语义**：**无条件构建**三平台矩阵（不看你最近提交改了什么），
适合「本地什么都不想改、但想跑一次构建 / 验证 Secrets」。push 与 PR 才会做变更过滤（仅当 `mcp-gui/**`、两个词表真源或 `gui.yml` 自身有改动时才构建），
以免纯文档提交也占满三平台 runner。

### 7.3 目录结构

```text
mcp-gui/
├── src/                  Vue 3 前端（views / components / stores / i18n / theme）
│   ├── api/              唯一数据出口（Tauri invoke 封装 + 可切换 mock）
│   └── core/             纯逻辑（日志行解析 / 事件解析 / 字节窗口 / 筛选 / 报告摘要 / 沙箱）
├── fixtures/             真实日志样本（脱敏），供 mock 与单测使用
├── scripts/              一致性检查、图标公钥注入、更新清单生成
└── src-tauri/            Rust 后端（data_home / scanner / event_stream / tail / watcher / search / export / updater）
```

---

## 八、安全边界

- 对业务数据**全程只读**；唯一的写入是应用自身偏好（系统应用配置目录）与用户显式选择的导出 / 更新临时文件；
- 所有「相对数据目录」的路径都做**越界防护**（拒绝绝对路径与 `..`）；
- 视觉验收 HTML 在 sandbox iframe 内渲染，且额外注入 CSP、剥离 `<script>`；
- 不读取、不存储任何业务密钥；日志内容不做外发。

---

## 九、已知限制

- **未做 Apple 代码签名 / 公证**（macOS 首次打开需手动允许）；
- **未提供 MSI**：Windows 仅 NSIS（自动更新的硬性要求）；
- **未构建 Linux 版本**；
- **不提供任务写操作**（取消 / 返修 / 续跑仍走 MCP 工具）；
- **不建本地全文索引**，搜索为按需扫描，超大日志目录下首次搜索会比较慢（可取消）；
- macOS 侧仅保证 CI 构建通过，未做真机功能验收。
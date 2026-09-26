# issue #25 真机验收记录 —— Tianshu-mcp 日志台

- 关联 issue：[#25](https://github.com/lanlan0811/tianshu-mcp/issues/25)
- 目标版本：**GUI 独立版本 `0.1.0-beta.1`**（独立 tag `gui-v0.1.0-beta.1`）；**不涉及 MCP 主包版本迭代**（主包仍为 `0.7.0`，尚未发布）
- 验收载体：**CI 构建产物**（`GUI` workflow 的 artifact，或 `gui-v*-beta.*` 的 pre-release 安装包）
- 验收平台：Windows 10（macOS 仅保证 CI 构建通过）

> 按 issue #25 的硬约束，本机**不安装 Rust 工具链、不执行任何 Rust 侧构建**，
> 因此真机验收一律以 CI 产物为载体；本文件在产物到位后按下方清单逐项补齐结果。

---

## 一、前置状态

| 项 | 状态 | 说明 |
|---|---|---|
| 本机 Node / npm | 可用 | 前端预览、单测、门禁脚本均可本地执行 |
| 本机 Rust 工具链 | **不使用** | issue #25 明确要求 Rust 侧一律在 CI 完成 |
| `gh` CLI | 不可用 | 故 artifact 需经浏览器从 Actions 运行页下载 |
| CI 构建产物 | **已生成** | `GUI` workflow 首次跑通：`windows-x86_64`（NSIS）与 `darwin-aarch64`（dmg/app）已产出并上传；`darwin-x86_64` 同步构建中 |
| CI 排障通道 | **注解 + 只读代理** | 公开仓 job 日志需 admin（403）→ 用 `check-runs/<job_id>/annotations` 读取诊断（详见 §三.2） |

---

## 二、待执行验收清单（产物到位后逐项填写）

### 2.1 功能（issue DoD 2，Windows 10）

| # | 步骤 | 期望 | 结果 |
|---|---|---|---|
| F1 | 启动应用，顶栏显示自动探测到的数据目录 | 显示 `TIANSHU_MCP_HOME` 或 `~/.tianshu-mcp` | 待测 |
| F2 | 加载真实数据目录（含 `tsk_*` / `vfy_*`） | 任务列表按时间倒序列出，状态色标与轮次正确 | 待测 |
| F3 | 打开 `task.jsonl` | 时间线区分状态跃迁 / Agent 事件 / note；坏行计数如实提示 | 待测 |
| F4 | 打开 `agent-<轮次>.log` 与 `verify-<轮次>.log` | 轮次可切换；行号 / 换行 / 级别过滤 / 关键字高亮可用 | 待测 |
| F5 | 打开 `report-<轮次>.md` / `.json` / `.html` | Markdown 渲染、结构化卡片、视觉 HTML 在沙箱内渲染 | 待测 |
| F6 | 打开 `dry-run-report-*` | 与常规报告分开展示，不混轮次 | 待测 |
| F7 | 实时 tail | 日志被追加时自动增量刷新；上翻自动暂停；「跳到最新」可用 | 待测 |
| F8 | 大日志分块加载 | 显示「已加载 N / 共 M」，向前加载生效 | 待测 |
| F9 | 跨任务搜索 | 命中分组、点击跳转、进度显示、可取消 | 待测 |
| F10 | 单文件导出 | 导出原文成功且内容一致 | 待测 |
| F11 | 任务整包导出（含排除大日志） | zip 生成成功，排除数如实回报 | 待测 |
| F12 | 语言 / 主题切换 | 中英切换即时生效；深/浅/跟随系统三态生效 | 待测 |

### 2.2 双源发布与自动更新（issue DoD 8/9）

| # | 步骤 | 期望 | 结果 |
|---|---|---|---|
| U1 | 打 `gui-v0.1.0-beta.1` tag | GitHub 与 Gitee **均为 pre-release**，各附 Windows + macOS 包 | 待测 |
| U2 | 校验 `gui-v*` 未连带触发 `release.yml` | MCP 发版链路未被触发 | 待测 |
| U3 | `update/gui/latest.json` 与 `latest-gitee.json` | 两端清单可被 updater 正确读取 | 待测 |
| U4 | 模拟中国大陆网络检查更新 | 命中 **Gitee** | 待测 |
| U5 | 模拟境外 / VPN（含中国香港、中国台湾）网络检查更新 | 命中 **GitHub** | 待测 |
| U6 | 三态开关 | 自动 / 强制 Gitee / 强制 GitHub 均生效 | 待测 |
| U7 | 两端均不可达 | 按设计回退并给出明确提示（无历史时回退 GitHub） | 待测 |
| U8 | 篡改更新包后安装 | **必须拒绝安装**（minisign 验签失败） | 待测 |

### 2.3 打包与隔离（issue DoD 5/6）

| # | 步骤 | 期望 | 结果 |
|---|---|---|---|
| P1 | `npm pack --dry-run` | `mcp-gui/` **未被打入** npm 包 | 待测 |
| P2 | 仓库状态 | `mcp-gui/node_modules`、`dist`、`src-tauri/target`、`icons/*`、`Cargo.lock` 均未入库 | 待测 |
| P3 | 图标 | 仓库内只有 `assets/tianshu-mcp-icon.svg`；无 emoji、无二进制图标 | 待测 |
| P4 | `tianshu-mcp-web/` | 未被改动 | 待测 |

---

## 三、CI 门禁结果

### 3.1 门禁现状（2026-09-27）

| 门禁 | 命令 / workflow | 结果 |
|---|---|---|
| 词表三方一致性 | `node mcp-gui/scripts/check-schema-parity.mjs` | ✅ 本地 + CI 均通过（TS 真源 / 前端镜像 / Rust 镜像 全部一致，含 23 项事件全集） |
| 前端 typecheck / lint / test | `mcp-gui` 的 `npm run typecheck` / `lint` / `test` | ✅ 本地 + CI 均通过（81 项用例） |
| Rust 质量门禁 | `GUI` workflow：`cargo fmt --check` / `cargo clippy -D warnings` / `cargo test` | ✅ **三平台全通过**（Windows / macOS aarch64 / macOS x86_64） |
| GUI 三平台构建 | `GUI` workflow（windows-latest / macos-15-intel / macos-15） | ✅ `windows-x86_64`（NSIS）+ `darwin-aarch64`（dmg/app）**打包并上传产物成功**；`darwin-x86_64` 同步 |
| 与 MCP 发版隔离 | `gui-v*` 不匹配 `release.yml` 的 `v*` | ✅ workflow 内显式断言通过（另见 `docs/gui-log-viewer.md` §7.2） |

### 3.2 本轮修复过程（首次跑通前）

按「CI 是唯一 Rust 侧真源」的约束，本机不跑 cargo；因公开仓 job 日志下载需 admin 权限（403），
诊断信息一律经 **GitHub 注解**（`::error` / `::warning` → `check-runs/<job_id>/annotations`，公开可读）取得，依次修掉三类问题：

| 轮次 | 失败面 | 根因 | 修法 |
|---|---|---|---|
| 1 | `cargo fmt --check` | 14 个 `.rs` **缺少文件结尾换行**；另有多处签名折行、链式调用折行、`mod` 声明顺序 | 按 `rustfmt` 实际 diff 逐处改正（`cargo fmt` 输出即权威） |
| 2 | Rust 编译（`cargo clippy` / `cargo test` 均 101） | **Tauri 2 规则**：`async fn` 命令含借用输入（`State<'_, T>`）必须返回 `Result<_, _>`，否则 `E0277` + `E0597 __tauri_message__`；另有 `if let` 守卫临时值晚于 `State` 释放的 `E0597`；`RecommendedWatcher` 未用导入（`-D warnings` 下为错误） | 4 个命令改为返回 `Result`；`if let` 后补 `;`；删未用导入 |
| 3 | `cargo clippy` `dead_code` | 词表常量在私有模块内且仅由 CI 脚本比对；6 个请求结构体的 `data_home` 字段 Rust 侧不读取（契约字段） | 显式 `#[allow(dead_code)]` + 注释说明用途 |
| — | 附带 | 跨平台测试断言：`C:/Windows` 在类 Unix 下只是普通相对路径 | 该断言加 `#[cfg(windows)]` |

> 排障关键细节（已同步至 `HANDOFF.md`）：**cargo / rustc 输出带 ANSI 颜色码**，解析前必须剥离，否则 `^error` 行匹配不到；
> Windows runner 上 `rustfmt` 的 diff 表头是 `Diff in <路径>:<行号>:`（非 Unix 的 `at line <行号>`）；注解有「单条 ~4K 字符 + 单步 10 条」上限，故按 2500 字符切块并分多步打印。

---

## 四、结论

**CI 侧已跑通**（2026-09-27）：`GUI` workflow 的 `schema-parity` 与三平台 `cargo fmt` / `clippy -D warnings` / `cargo test` 全绿，
且 `windows-x86_64`（NSIS）与 `darwin-aarch64`（dmg/app）**已成功打包并上传产物**，`darwin-x86_64` 同步构建中。

**第二、三节的功能与更新清单（F1~F12 / U1~U8 / P1~P4）仍需维护者用 CI 产物在真机上逐项验收**——
本机按 issue #25 的硬约束不跑 Rust 侧，也不具备双系统的真机点击条件；产物到位后按清单填写即可。

已知限制（已在 `docs/gui-log-viewer.md` 如实披露）：

1. macOS 未做 Apple 代码签名 / 公证；
2. 未提供 MSI（Windows 仅 NSIS）；
3. 未构建 Linux 版本；
4. 无任务写操作、无本地全文索引；
5. macOS 侧仅保证 CI 构建通过。
6. 签名 Secret 未配置前，产物不含更新清单（自动更新不可用，安装包本身可正常使用）。
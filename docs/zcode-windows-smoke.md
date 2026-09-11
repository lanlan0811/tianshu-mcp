# ZCode Windows 真机验收记录

验收日期：2026-09-11  
环境：Windows 10 x64，ZCode `3.11.2.6792`（自动发现 `D:\Z-Code\ZCode\ZCode.exe`），模型 `DeepSeek/deepseek-flash`，权限模式“完全访问”。

所有任务都在隔离的临时 Git fixture 中运行，未修改本仓库或用户项目。MCP 保留 ZCode 实例，没有自动关闭用户窗口。

| 场景 | 任务 / 会话 | 结果 |
|---|---|---|
| 真实文件开发 | `tsk_20260911173032_edc5bb` / `sess_1cc7b011-e1a4-4caf-bb2f-cc6096026db4` | ZCode 创建 `done.txt=PASS`；`git diff --check` 与 `node check.mjs` 均通过（2/2），结束原因 `reply_stable` |
| 受控验收失败与自动返修 | `tsk_20260911175749_f2678a` / `sess_d3d15c20-8458-4b12-95bc-0b85eee41812` | 第 0 轮生成 `FAIL` 并按预期验收失败；MCP 生成唯一返修计划，第 1 轮在同会话改为 `PASS`，最终 2/2 通过 |
| 模型提问与续跑 | `tsk_20260911184918_0ffe5f` / `sess_5a665e9c-f9b1-4f21-847f-db4d492ca5a2` | ZCode 真实调用 `AskUserQuestion`，MCP 返回 `needs_user`；`continue_task(PASS)` 在原会话问题卡片精确选项并提交，未向普通 composer 重复发送，续跑后 2/2 验收通过 |

同一轮验收还覆盖：已有无 CDP 实例只返回 `needs_user`、原生文件夹面板导入、项目完整路径回读、模型显示值/内部 ID 回读、权限回读、发送证据确认、新会话稳定 ID 追踪、渲染器重载恢复和延迟接收。

macOS 代码路径有单元与假 CDP/CI 覆盖，但尚无真机证据，因此内置 ZCode profile 保持 `research`。

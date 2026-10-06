# v0.8.0 — 恢复既有会话时不再改写用户语义（issue #35 / #30）

> 详见 [CHANGELOG](../CHANGELOG.md#080---2026-10-06)。

## 本版主题：恢复轮必须忠于原会话

两条独立报告（TraeWork #35、ZCode #30）指向**同一族缺陷**：`continue_task` / `rework_task`
在恢复既有会话时，把用户原本请求的模式或权限**静默改写**为默认值。两者都没有报错、没有界面变化，
用户看到的只是一次「成功但行为不对」的恢复——这正是最难被察觉的一类失真。本版把两处都纠正为
**恢复语义忠于原会话**：请求什么就是什么，缺记录才回落默认。

## 修复一：TraeWork 移除跨模式项目绑定兜底（issue #35）

`bindProject()` 在非 Work 模式（Code / Design）绑定失败时，会**回落 Work 模式**完成绑定，
再切回目标模式。该兜底在「各模式独立绑定」的语义下**结构性不可达**：

| 步骤 | 期望 | 实际 |
|---|---|---|
| 在 Code 模式绑定 | Code 模式持有项目 | 失败（非 Work 模式下「选择文件夹」UI 不稳定） |
| 回落 Work 模式绑定 | 为 Code 模式完成绑定 | 项目绑给了 **Work** 模式 |
| 切回 Code 模式 | Code 模式仍有项目 | **项目丢失**（模式间不继承） |
| 结果 | 绑定成功 | **仍失败**，且原目标模式已被静默改写为 Work |

即：兜底既救不了失败，又**篡改了用户请求的模式**。本版**移除整个兜底分支**——非 Work 模式绑定
失败即如实返回失败，**不改变请求的模式**，交由调用方决策（重试 / 换模式 / 报错）。

## 修复二：ZCode 恢复轮保留原会话权限（issue #30）

`runZcodeTask` 先按 `ctx.resume.permissionMode` 求得权限：

```ts
let permission = ctx.resume?.permissionMode ?? gui.defaultPermissionMode ?? "完全访问";
```

但发送前又**无条件覆盖**它：

```ts
permission = gui.defaultPermissionMode ?? "完全访问";   // ← 无论是否恢复轮
```

该覆盖段位于 `initialDispatch` 块**之外**，恢复轮同样执行，于是：

- 原会话权限被静默改回 profile 默认值；
- 随后以该值**强制切换界面**并回读；
- `session.permissionMode` 回执随之失真。

修法为**从状态被错误突变的位置移除**，而非在消费端兜底：

- `permission` 改为 `const`（全文件**仅此一处**取值，改 `const` 自洽）；
- 删除 1193 的无条件覆盖——**仅在记录缺失时**回落 profile 默认值；
- 权限回读不一致时报错文本携带**实际目标权限**（原先固定显示「完全访问」，会误导排查）。

## 行为边界

- 两处修复都**不改动任何成功路径的行为**，也不新增功能或界面变化。
- 缺记录时的回落顺序**未变**：`ctx.resume.permissionMode` → `gui.defaultPermissionMode` → `完全访问`。
- 权限回读不一致仍**硬失败**（`endReason: permission_unknown`），只是错误信息更准确。

## 验证

- **TraeWork**：`vitest run traework` 15 文件 / 139 用例通过；把 `session.ts` 回退到审查基线
  `39a00243`，`traework-bind-fallback.test.ts` 两条行为用例如实失败
  （`expected 'Work' to be 'Code'` / `expected 'Work' to be 'Design'`）——正是 issue #35 描述的
  「回切后落在 Work 模式」根因；恢复实现后通过。
- **ZCode**：应用 PR #37 后三个相关测试文件 **85 passed**；仅将 `src/agents/zcode/run.ts` 回退到
  基线再跑，新增用例 **5 failed / 3 passed**，失败点即被测层——`fake.permission` 期望「受限访问」
  实得「完全访问」，正是那行无条件覆盖的物理表现。
- `tsc --noEmit` / ESLint `--max-warnings 0` / `git diff --check` 通过。
- 两处修复都在**本地独立复现 RED→GREEN**，未采信 PR 描述。

## 已知限制

- **ZCode 侧仅有假 CDP 集成测试，缺真机（真实 ZCode 3.14.x）复现**——这是 PR #37 声明的边界，
  本版沿用；真机验证仍待补。
- **TraeWork 兜底的移除基于「模式间不继承绑定」的既有语义**；若上游 TraeWork 改变该语义，
  需重新评估（该分支本就为「非 Work 模式 UI 不稳定」而写，移除后该类失败将**如实暴露**而非被兜底掩盖）。
- 全量 `vitest run` 中 `test/integration/zcode-rework-loop.test.ts` 存在**等待终态超时的时序 flake**，
  在 base master 上同样复现，与本版两处修复无关。
- 本版**不含 mcp-gui（日志台）的任何改动**——GUI 走独立版本线 `gui-v*`（当前 `0.1.1-beta.4`）。

## 鸣谢

- @jian-in：TraeWork 绑定修复（PR #36）与 ZCode 权限恢复修复（PR #37）。

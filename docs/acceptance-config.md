# .tianshu-mcp/acceptance.json 规范

项目级验收配置：把该文件放在项目根目录的 `.tianshu-mcp/acceptance.json`，tianshu-mcp 对该项目做验收（run_task 自动验收 / verify_task）时优先读取它。

## 配置优先级（高 → 低）

1. `verify_task` 调用时的 `extraChecks`（临时追加，不落盘）
2. 项目内 `<project>/.tianshu-mcp/acceptance.json`
3. server 数据目录 `projects.json[pathHash].verify`（管理员补录）
4. 默认集（按项目技术栈自动推导，见下）

## 文件格式

```jsonc
{
  // checks 数组：每条 = 一项自动命令检查
  "checks": [
    {
      "name": "typecheck",               // 必填，报告中显示名
      "cmd": ["npm", "run", "typecheck"], // 必填：argv 数组（推荐，非 shell）
      // 也可以写字符串，会被安全分词（不经过 shell）：
      // "cmd": "npm run typecheck"
      "timeoutMs": 120000,               // 选填，单条超时；缺省 server 级 5 分钟
      "optional": false                  // 选填；optional:true 失败只提示不判失败（未来语义，当前仍参与判定）
    },
    { "name": "lint", "cmd": ["npm", "run", "lint"] },
    { "name": "test", "cmd": ["npm", "test"] }
  ]
}
```

## 语义

- 每条命令在**项目根目录**、以结构化 argv 执行（`shell:false`，不拼接 shell 字符串），stdout/stderr 写入该轮 `verify-N.log`，报告附输出尾部。
- **任一非 optional 检查失败 ⇒ 该轮验收失败**；跳过/超时各自标记。
- 内置额外检查（不经配置）：
  - `git-diff-check`：`git diff --check`（空白错误）；非 git 仓库自动跳过。
- 若配置缺失/解析失败，自动落回更低优先级来源，最终为空则只有内置检查，并在报告注明。

## 默认集（无任何配置时自动推导，v1 覆盖）

| 检测到 | 检查 | 缺失处理 |
|---|---|---|
| 任意项目 | `git diff --check`（内置） | 非 git 仓库跳过并标注 |
| `package.json` 有 scripts | `npm run typecheck` / `lint` / `test` / `build`（各自独立） | 脚本不存在即跳过并标注 |
| `tsconfig.json` 且无 npm scripts | `npx tsc --noEmit` | — |
| `pytest.ini` | `pytest -q` | — |
| `go.mod` | `go test ./...` | — |
| `Cargo.toml` | `cargo test` | — |

> 规则数据化，可后续扩展；不需要改代码。

## 与 tasks 结合

- 每轮验收产出 `report-N.md` + `report-N.json`（N 为轮次），存于该任务数据目录 `tasks/<taskId>/`。
- `report.json.checks[]` 每条含 `{name, cmd, passed, durationMs, exitCode, outputTail, timeout, skipped, reason}`。
- 变更/diffstat/可疑标记在 `report.json.analysis` 段，全部相对 **run_task/rework_task 动工前 git 基线**。

## 常见问题

- **验收命令找不到 node/npx**：tianshu-mcp 子进程会显式继承并前置 PATH（含系统 node 目录与天枢自带 node 目录）。若仍异常，检查你的 PATH。
- **想临时加验**：`verify_task(taskId, extraChecks=[{name:"x", cmd:["…"]}])`，不改文件。
- **不想让某脚本缺席导致一堆 skip**：接受即可，skip 不算失败，报告会标注缺失原因。

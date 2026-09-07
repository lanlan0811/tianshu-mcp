# DoD #7 真实发布与 npx 拉起连通记录

- 日期：2026-09-07
- 发布者账号：npmjs `lotteai`（用户提供凭据）
- 版本：`tianshu-mcp@0.1.1`（package.json 与 git tag v0.1.1 一致）

## 1. 发布（npm publish）

```bash
npm publish --registry=https://registry.npmjs.org
# ...
# + tianshu-mcp@0.1.1
```

## 2. registry 核验

```bash
npm view tianshu-mcp version --registry=https://registry.npmjs.org   # → 0.1.1
npm view tianshu-mcp dist-tags --registry=https://registry.npmjs.org # → { latest: '0.1.1' }
```

## 3. npx -y 拉起连通（官方 SDK 协议冒烟）

全新临时目录，用 `@modelcontextprotocol/sdk` Client 连 `npx -y tianshu-mcp`：

```
npx -y tianshu-mcp tools: cancel_task,get_profiles,get_task_report,list_tasks,query_task,rework_task,run_task,verify_task
meta.ok = true | 含 codex = true
NPX RAISED CONNECT OK
```

- `tools/list` 列出全部 **8 个工具**
- `get_profiles` 调用成功，meta 块 `ok=true`，内容含 codex（可执行探测）

## 4. 结论

修复计划 §12.6 / DoD #7 达成：npm registry 包 `tianshu-mcp@0.1.1` **已发布**，且可由天枢 `npx -y tianshu-mcp` 拉起并连通（8 工具注册 + tools/call 成功）。

# v0.1.8 发布说明

- 发布日期：2026-09-08
- 版本：`tianshu-mcp@0.1.8`
- 许可证：Apache-2.0
- 英文版：[release-v0.1.8.en.md](release-v0.1.8.en.md)

---

## 本次修复：原子写并发缺陷（CI 偶发失败的真实根因）

v0.1.7 推送后 CI 在 **windows / Node 20** 上失败（其余 6 个矩阵全绿），失败断言是：

```
AssertionError: expected undefined to be 'queued'
  ❯ test/integration/rework-feedback-race.test.ts:58
  ❯ test/integration/task-flow.test.ts:137
```

即 `rework_task` 偶发返回的 meta 为 `undefined`。由于该提交只改了文档，这是**被掩盖的真实缺陷**。

### 根因（本地复现）

`writeJsonAtomic` / `writeTextAtomic` 的临时文件名是 `<目标>.<pid>.tmp`：

- **同进程并发写同一目标**时，多个写操作**共用同一个临时文件**——先完成的一方 `rename` 走后，
  后完成的一方 `rename` 抛 `ENOENT`（本地 5 路并发实测 1 次失败）；
- **Windows 上并发 rename 到同一目标**还会抛 `EPERM`（文件正被另一个 rename 占用，本地 8 路并发实测 2 次失败）。

`rework_task` 恰好会连续写快照（`rework` 与收尾各一次），命中该竞态后就拿不到 meta。

### 修复

1. **临时文件名加随机后缀**：`<目标>.<pid>.<12位随机>.tmp`，每次唯一。
2. **rename 瞬时错误退避重试**：`EPERM`/`EBUSY`/`EACCES` 视为瞬时错误，10/20/…ms 退避重试最多 10 次。

验证：8 路并发写同一目标 **0 失败**（修复前 2/8 失败）；新增回归测试连续 3 轮全绿。

## 变更清单

| 类型 | 内容 |
|---|---|
| 修复 | `src/util/fs.ts`：临时文件名唯一化 + rename 瞬时错误退避重试 |
| 新增 | `test/unit/atomic-write.test.ts`（3 项：并发 JSON/文本写全部成功、不残留临时文件） |
| 测试 | 178 → **181** 全绿 |

## 与本版本无关但同批交付

v0.1.7 的项目文件夹绑定根因修复（`toNativeWindowsPath`）已在该版本发布，本版本只含原子写修复。

## 升级

```bash
npm install -g tianshu-mcp@0.1.8
```

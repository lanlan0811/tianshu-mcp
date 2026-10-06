# 日志台 0.1.1-beta.5 — 深链解析对畸形百分号编码的容错收口（issue #33）

> 完整变更记录见 [CHANGELOG](../CHANGELOG.md)；功能文档见 [docs/gui-log-viewer.md](gui-log-viewer.md)。

这是 0.1.1 线的**缺陷修复版**，交付 issue #33：深链解析器 `parseDeepLink` 对**畸形百分号编码**抛
`URIError`，与它自己声明的「其余一律返回 `null`」契约矛盾。本次把解码失败收口为「无法识别」，
**不再上抛**。**无新增功能、无界面新增**——但**有一条用户可见的行为变更**：畸形深链由静默失效
改为如实提示，且不再瘫痪整个会话的深链订阅。

---

## 本次修复

### 深链解析对畸形百分号编码不再抛 `URIError`（issue #33）

**问题**：`mcp-gui/src/core/deeplink.ts:46` 的 `decodeURIComponent(segments[0])` 是**裸调用**，
无 `try/catch`。而该函数文件头写明的契约是「**其余一律返回 `null`**（不猜、不宽松匹配）」——
**实现与契约不符**。深链是**外部可构造输入**（`tianshu://` 协议可被任意网页 / 脚本触发），
`tianshu://task/%zz` 这类畸形转义会抛 `URIError: URI malformed`。

**根因不是「漏了一处校验」，而是口径分裂**：同一个函数内已有 3 处针对外部输入的防御
（`new URL` 的 try/catch、`..` / `%2e` 的前缀拒绝、白名单判定），**唯独 `decodeURIComponent`
被当成了不会失败的纯函数**。同仓 `src/visual/services.ts:62-67` 的同类解码**就包在 `try/catch` 里**
（HTTP 请求路径解码）——一处有防护、一处没有。

**修法**（最小充分修复，只改一处）：

```diff
   const segments = parsed.pathname.split("/").filter((seg) => seg !== "");
   if (segments.length !== 1) return null;
-  const taskId = decodeURIComponent(segments[0] as string);
+  // `decodeURIComponent` 对**外部可控**的畸形转义抛 `URIError`（`%zz`、`%`、`%80` 等），
+  // 而本函数的契约是「其余一律返回 null」（见文件头）。深链的入队侧不做业务判断
+  // （`lib.rs` 的 `queue_deeplinks` 只入队），故畸形输入必然走到这里——必须就地收口：
+  // 解码失败即「无法识别」，交由调用方如实提示，绝不上抛。
+  let taskId: string;
+  try {
+    taskId = decodeURIComponent(segments[0] as string);
+  } catch {
+    return null;
+  }
   if (!TASK_ID_RE.test(taskId)) return null;
```

**为什么修在这里而不是在 `App.vue` 加防御性 catch**：调用侧需要知道「这条链接无法识别」才能给出
提示（`setError(t("deeplink.invalid", …))`）。错误必须转为**返回值**，不能靠外围拦截——在外围补
catch 只会让畸形链接被静默吞掉。

---

## 覆盖的输入形态（两类，都会被抛）

| 类别 | 样例 | 为什么抛 |
|---|---|---|
| ① 转义格式非法 | `%zz`、`%`、`%z`、`%2`、`%%`、`%C3%28`、`%E0%A4%A` | 不是合法的 `%XX` 序列 |
| ② 格式合法但解码结果非合法 UTF-8 | `%80`、`%FF`、`%ED%A0%80` | 孤立续接字节 / 非法字节序列 |

**只覆盖 ① 是不够的**：issue 举例是 `%zz`（类别 ①），但类别 ② 同样抛错、同样外部可构造。
本次两类都测。

| 输入 | 修复前 | 修复后 |
|---|---|---|
| `tianshu://task/%zz` | **抛 `URIError`** | `null`（如实提示） |
| `tianshu://task/%80` | **抛 `URIError`** | `null`（如实提示） |
| `["…/%zz", "…/tsk_2"]` 批量 | **整批中断**（`tsk_2` 被吞） | 越过畸形的，选中 `tsk_2` |
| `tianshu://task/tsk%5F1` | `{taskId:"tsk_1"}` | **同左（逐字不变）** |
| `tianshu://task/a%2Fb` | `null` | **同左** |
| `tianshu://task/tsk%5C1` | `null` | **同左** |
| `tianshu://task/tsk_1` | `{taskId:"tsk_1"}` | **同左** |
| `..` / `%2e` / 空 / 多段路径 | `null` | **同左** |

**顺序不变量**：`tsk%5F1` 一行是判据——它要求**先解码、再判白名单**。若把 `try/catch` 误放到
白名单之后、或改成「先校验原串」，这条会从绿转红。

---

## 用户可见行为变更（本版最重要的一条）

修复前实测（本地复现，非推断）：

| 观察项 | 修复前 | 修复后 |
|---|---|---|
| `App.vue:170` 的 `subscribeDeepLinks(...)` 是否可达 | **false** —— `await drainDeepLinkQueue()` 抛出后永不执行 | true |
| `setError` 调用次数 | **0** —— 用户零提示 | 1（如实提示无法识别） |
| 该会话后续深链 | **全部失效**（订阅器没注册） | 正常接收 |

即：冷启动时若队列里混入**一条**畸形链接，修复前会导致**整个会话的深链功能整体失效**且**毫无提示**；
修复后该链接被如实提示，其余深链正常工作。这条影响比 issue 原文所述（「一处抛错会中断整批取队列/路由」）
更重，实测把后果坐实到了「订阅链断掉」。

---

## 测试与验证

- 前端 **172 passed**（15 文件，基线 169 + 新增 3 组），`check:schema`（含 `GUI 版本号一致（0.1.1-beta.5）`）
  / `typecheck` / `lint` 全绿。
- 新增用例：10 条畸形输入（两类别）的「不抛错 + 返回 `null`」；批量不阻断；解码顺序不变量。
- **RED → GREEN 实证**：先落用例拿到红灯（`URIError: URI malformed`，根因栈指向 `deeplink.ts:46`），
  再改实现转绿。
- **回滚自检**：把修复改回裸调用后，2 条新用例**重新变红**（`2 failed | 6 passed`）——证明测试有辨别力。

---

## 口径说明

- **改动面**：1 个源文件（`src/core/deeplink.ts`，一处 `try/catch`）+ 1 个测试文件 + 4 份双语文档。
- **Rust 侧零改动**：`lib.rs` 的入队（`queue_deeplinks`）与取队列（`take_pending_deeplinks`）
  **有意不做业务判断**——畸形 URL 本就会入队，前端解析层才是契约所在地（与 §16.10 的职责划分一致）。
- **同族落点已清点**：全仓 5 处 `decodeURIComponent` 逐条判定——本 issue 外，`src/visual/services.ts:63`
  与 `src/agents/zcode/model.ts:182` 已有 `try/catch`；`scripts/gitee-gui-release.mjs:325` 与
  `mcp-gui/scripts/build-updater-manifest.mjs:188` 不受外部输入控制。`src/agents/kimicode/dom.ts:174`
  无 `try/catch`，但运行在 `page.evaluate` 注入脚本里、异常由外层 CDP 调用捕获，**记为同族观察项，
  本次不改**（避免范围蔓延到 agent 适配器子系统）。

---

## 边界（本版没做什么）

- **不新增功能、不改界面**：无新页面、新分区、新命令；i18n 零新增键；`src/api` 方法签名不变。
- **不动 Rust**：不改任何 `.rs` 文件。
- **不放宽既有测试**：既有 5 个深链用例逐字未改。

---

## 升级说明

- 更新路径与 `0.1.0` / `0.1.1-beta.1` … `0.1.1-beta.4` 共用同一份 `latest.json` /
  `latest-gitee.json`，按语义版本号比大小，`0.1.1-beta.5 > 0.1.1-beta.4`，可直接从任一更早版本升级；
- 本版修复解析层容错，既有功能（任务列表 / 四类日志 / 搜索导出 / 更新检查 / 洞察四分区 /
  命令面板 / 深链）**行为不变**——仅畸形深链的处理方式由「静默失效」改为「如实提示」。

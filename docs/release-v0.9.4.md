# v0.9.4 — Codex 发送确认修复版

> **修复「指令已送达却判为无法确认」**：26.1002 下发送确认判据 `seenMessage` **恒为 false**，
> 报 `send_unknown`，用户看到的是「文本已键入但未触发发送」——**而消息实际早已送达**。
> 根因是对话文本采集**丢弃纯文本节点**，令 `【tianshu:…】` 标记的中间段丢失。

**本版无破坏性变更、工具面不变（仍 8 个工具），升级无需改调用方。**

---

## 背景

v0.9.3 修复了「发送确认假成功」（读到了不该读的文本）。本版修的是**它的反面**：
**该读到的读不到**——真阳性被误判成阴性。

两者是同一个采集函数的两次失误，只是方向相反：

| 版本 | 缺陷 | 方向 |
|---|---|---|
| v0.9.3 前 | `messageArea` 包住 composer → 输入框里的文本被当作"已送达" | **假阳性** |
| v0.9.4 前 | 叶子遍历丢弃 `#text` → 对话区的标记被读残 | **假阴性** |

---

## 根因

Codex 的消息正文在 DOM 里是**碎片化**的——标记被切在多个节点中，
且**元素节点与纯文本节点交错**（真机实测）：

```
SPAN     "【tianshu"
#text    ":tsk_20261009083825_4d992a"
#text    ":r0"
#text    ":initial"
SPAN     "】在当前项目创建 docs/verify-fix.md…"
```

v0.9.3 引入的节点级遍历实现是：

```js
for(const c of n.children){hasElementChild=true;walk(c)}   // 只遍历 children（元素）
if(!hasElementChild){
  const t=(n.textContent||'').trim();                       // 有元素子节点就丢弃自身文本
  if(t)parts.push(t);
}
```

它**只遍历元素节点**，且「有元素子节点就丢弃自身文本」——于是四个 `#text`
节点被**整批丢掉**，拼接结果退化为：

```
【tianshu】在当前项目创建 docs/verify-fix.md…
```

**中间段 `:tsk_20261009083825_4d992a:r0:initial` 全部丢失。**

`run.ts` 的发送确认判据是 `conversationText.includes(marker)`——
marker 读残 → `seenMessage` 恒 false → 三判据全 false → 报 `send_unknown`。

**真机反证**（同一个任务，采集修复前后对比）：

| | `conversationText` | 含完整 marker |
|---|---|---|
| 修复前 | 289 字符，读到 `【tianshu】…` | **false** |
| 修复后 | 291 字符，读到 `【tianshu:tsk_…:r0:initial】…` | **true** |

同时另有取证证明消息**确实已送达**：`composerText` 165 → 0（文本离开输入框）、
停止按钮出现（运行信号）、产物 `docs/verify-fix.md` 落盘。

---

## 修复

遍历从 `children` 改为 `childNodes`（含 `#text`），按文档顺序拼接；
composer 组件节点仍整棵跳过：

```js
const walk=(n)=>{
  if(n.nodeType===3){                       // 纯文本节点：直接收集
    const t=(n.nodeValue||'').trim();
    if(t)parts.push(t);
    return;
  }
  if(n.nodeType!==1)return;
  if(isComposerComponent(n))return;         // composer 组件仍整棵跳过
  for(const c of n.childNodes)walk(c);      // 关键：childNodes 而非 children
};
```

---

## 验证

**回归锁**（新增 1 条，复刻真机 `SPAN`/`#text` 交错形态）：

```
AssertionError: expected '【tianshu】在当前项目创建 docs/verify-fix.md'
  to contain 'tianshu:tsk_20261009083825_4d992a:r0:initial'
```

——失败信息**逐字**等于真机现象，即 RED 复现了原缺陷。

**反证闭环**：回滚 `src` 修复（保留测试）→ 读到 `【tianshu】…` 变红；
恢复修复 → 绿。

**真机端到端**（`tsk_20261009102459_0e6869`）：

```
[codex] 指令已确认发送（对话区=true，输入清空=true，运行信号=false）
任务 tsk_20261009102459_0e6869 结束: succeeded
```

| 判据 | 结果 |
|---|---|
| `seenMessage`（上轮恒 false） | **true** |
| 对话哈希 | 逐轮变化：`b86128cc` → `a5fddf7f` → `1c6bb700` → `108a8d3d` → `4cfcc9ca` |
| 稳定轮 → 终态 | 4 轮后 `reply_stable` |
| 产物 | `docs/send-fix-verify.md`（111 B，「# 发送验证」+ 正文）落盘 |

**门禁**：typecheck 绿 / eslint 绿 / 全量 `1688 passed`（2 个失败为本地环境既存，
基线实验证明在既绿提交上同样失败）。

---

## 已知问题

1. **模型选择器混入分组标题**：新版分组标题（如「默认/推荐模型集」）与真模型项同为
   `role="menuitemradio"`，可能混入模型候选（真模型项有 `data-state`，标题没有）。
2. **`messageArea` 可能命中隐藏壳**：真机实测存在两个 `MainContentSurface`，
   首个为 0×0 隐藏壳（其 `vis()` 判定依赖尺寸，未见误取，但值得加一道防御）。

---

## 升级方式

```bash
npm i -g tianshu-mcp@0.9.4
```

或使用 MCP 客户端配置 `npx -y tianshu-mcp@0.9.4`。

**无需改动调用方**——工具面与参数契约均未变化。

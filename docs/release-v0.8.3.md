# tianshu-mcp v0.8.3

**缺陷修复版**（issue [#38](https://github.com/lanlan0811/tianshu-mcp/issues/38)，承接 [#35](https://github.com/lanlan0811/tianshu-mcp/issues/35) 遗留的两条建议）。

本版修两个独立缺陷：TraeWork 下拉底部点击的**重试决策用错了输入信号**，以及**逻辑性 setup 失败被误报为环境性失败**。

---

## 问题 A：点击「成功」却白等满 20s

`src/agents/traework/cdp/client.ts` 的 `click()` 注释写着「DOM click 优先，失败回退坐标点击」，实现却是：

```ts
if ((await this.evaluate<boolean>(expr)) === true) return true;   // 弱信号即「成功」
```

而这个 `true` 只表示「**元素存在且可见**」——**不表示原生弹窗已被唤起**。对 DirectUI 按钮这是间歇性事实（`element.click()` 返回成功却不弹窗，见 #35 实测记录）。由于该值被当作成功，坐标回退分支**只在 evaluate 抛错时才可达**。

后果链条：

```
e.click() 假装成功 → 日志写「点击=选择器」→ waitDialogAppeared(20_000) 死等 → 判失败
                     └─ 这 20s 内没有任何补救动作
```

**根因不是「缺少坐标点击」，而是「判定点击是否生效的依据是调用返回值，而不是副作用」。**

### 修法：副作用驱动的三级阶梯

判据改为「**原生对话框是否确实出现**」，执行方式按可靠性降序：

| 级 | 方式 | 依据 |
|---|---|---|
| ① | 坐标点击 `clickAt` | 真实鼠标事件，等价 `Input.dispatchMouseEvent`；#35 真机实测稳定弹出 |
| ② | 语义键 DOM `click` | 弱信号（可能是「返回成功却不弹窗」的那一级） |
| ③ | 文本兜底 | 扩大到 footer / 下拉容器内按文本「选择文件夹」匹配 |

每级有**独立有界探测窗**（首级 = 预算 × 0.30），失败**必升级**，日志记录实际生效方式（取代误导性的「点击=选择器」）。

## 真机抓到的第二个缺陷：预算膨胀 41%

首轮真机测量把 20s 预算跑成了 **28183ms**：

| 真机实测 | 值 |
|---|---|
| 旧实现总耗时 | **28183ms**（+41%） |
| 修后总耗时 | **19213ms ≤ 20000ms** |

根因：`waitDialogAppeared` **先探测、后判 deadline**，而单次探测实测 **1.0–4.8s**（PowerShell 冷启动 + `EnumWindows`），于是每级末尾都多溢出「一次探测 + 固定 `sleep(1500)`」。

修法三件套：

1. **探测前**判剩余预算（`MIN_PROBE_COST_MS`）；
2. `sleep` 不越过窗口边界；
3. **每级至少允许探测一次**——否则短预算下坐标首级会被直接跳过。这条回归被 `A-core` 当场抓到（`expected '选择器' to be '坐标'`），没有它就会「修一个假阴性、引入另一个」。

> **一处与 issue 建议的实质分歧**：issue 建议「把首次等待收窄到 2–3s」。实测反驳——单次探测就要 1.0–4.8s，2–3s 窗口只够 **0–1 次探测**，对话框稍慢即被误判失败并回退到**更不可靠**的 DOM click。故保留 20s 总预算，改为**按比例切分**。

---

## 问题 B：逻辑性失败被报成 `errorType=spawn`

`src/loop/fix-loop.ts` 把 `hardFailure` 一律映射为 `spawn`，而上游 adapter 已握有失败性质（`endReason=setup_failed`）——**性质在映射点被丢弃**。

`spawn` 的语义是「进程拉起失败」。而 #35 记录的原始现象正是一个**确定性必失败**的逻辑缺陷（Code 模式下项目未绑定）报了 `spawn`——读日志的人会当作环境问题反复重试。

### 修法：适配器自归类 + 编排器安全缺省

```ts
// src/agents/adapter.ts
errorType?: "spawn" | "setup_failed";   // 适配器对失败性质的自我归类

// src/loop/fix-loop.ts
const errorType = runRes.errorType ?? "spawn";   // 缺省逐字不变
const headline = errorType === "setup_failed" ? "setup 阶段失败" : "agent 基础设施失败";
```

TraeWork 的 7 个 `hardFailure` 点按「**重试/换环境是否可能成功**」分流：

| 失败点 | 归类 |
|---|---|
| 模式切换失败 / 项目绑定失败 / 绑定后模式变化 / 绑定校验失败 / 模型切换失败 | **`setup_failed`** |
| 未找到可执行文件 / `cdp_lost` | `spawn`（真·基础设施） |

**其余 6 个 agent 零行为变化**（缺省 `spawn`），并有回归锁断言这一点。

### 影响面比预想的小

`errorType` 在 MCP `formatter.ts` 是 `string`、GUI `types.ts` 是 `string | null` 且筛选选项来自**动态分面**（`filter.ts`）、Rust `insights.rs` 是自由字符串——**新增取值向后兼容**。`mcp-gui` 的 `check:schema-parity` 只校验状态/事件词表，不含 `errorType`。

---

## 验证

| 项 | 结果 |
|---|---|
| **RED→GREEN（问题 B）** | 基线 **4 failed**（`expected undefined to be 'setup_failed'` / 文案 `agent 基础设施失败`）→ 修复后 **12 passed** |
| **反向对照（问题 A）** | `A-budget-real` 回退修复后**变红**：旧实现探测 **12 次**（每级无界循环），新实现 **3 次** |
| **真机成功路径** | TraeWork CN `1.107.1`（CDP 9222、mode=Code）：**`via=坐标`、5938ms、hwnd=14616800**（对照：旧实现同场景白等满 20s） |
| **真机预算路径** | **19213ms ≤ 20000ms**（修复前 28183ms） |
| 全量测试 | **1629 passed / 1 failed → 修复后全绿**（唯一失败是本轮注释误用 `⚠️` 触发 `protocol-text.test.ts` 的 emoji 门禁，已修） |
| `mcp-gui` | 172 passed |
| `tsc --noEmit` / `eslint --max-warnings 0` | 全绿 |

## 已知限制

- **真机未复现**「DOM click 触发但对话框不弹」这一间歇现象本身。假 CDP 用例锁定的是**决策逻辑**（副作用驱动 vs 返回值驱动），真机验证的是**修复后的实际点击方式与耗时**——不声称真机复现了原间歇概率。
- **第三级「文本兜底」在当前默认预算下只分到约 34ms**（第二级吃掉全部剩余）。要真正保留三级能力需把第二级也改为比例切分；本轮不改（issue 的 DoD 是「坐标优先 + 不再白等 20s」，已达成）。
- **下拉未展开时 `center("cascadeMenuFooter")` 仍返回坐标**（fallback 选择器命中常驻元素），坐标点击可能落在无效位置并空耗首级窗口。有三级兜底故不致命，选择器收紧留待后续。
- **问题 B 未单独做真机验证**（需改变用户工作区绑定状态）；其逻辑由 adapter 层 + orchestrator 层双层断言覆盖。
- 不承诺「所有 TraeWork 版本」兼容性——真机结论以实测版本 `1.107.1` 为准。

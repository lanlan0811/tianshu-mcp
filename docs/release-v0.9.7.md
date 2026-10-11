# v0.9.7 — Open Design 真机修复版

> **接通此前零调用方的产物导出链路 + 修复三轮真机冒烟定位的 4 处适配器缺陷**：
> ① 首页入口漂移导致 `selector_drift` 硬失败；
> ② 失败态判据三层未接线，失败界面上空等到时限（10 分钟+）；
> ③ 工作目录回读假失败（`title` 形态判据 + 产品异步落盘晚 8.2 秒）；
> ④ 产物导出从未接线（`exportArtifact` 零调用方），本版接通并真机验证 zip / html 双格式。

**本版无破坏性变更、工具面不变（仍 8 个工具），升级无需改调用方。**
新增**可选**参数 `exportKind`（`html` / `zip`）：任务成功结束后自动把产物导出到 `projectPath`。

---

## 背景

对 Open Design（**0.24.1**）做真机冒烟，模型 `cline-pass/deepseek-v4.1-flash`，
工作区 `D:\Trae项目\AI游戏\Minecraft`。三轮测试依次暴露了下面四处缺陷；
第 ④ 项是本次的核心交付——它此前**从未被接上**。

---

## 新增 ④：产物导出链路（此前 `exportArtifact` 零调用方）

`export.ts` 早先已实现完整导出逻辑（选菜单项 + 驱动原生保存对话框）并有单测，
但 **`run.ts` 从未调用它**，schema 也没有 `exportKind` 字段——
典型的「判据齐全、接线缺失」。这与缺陷 ② 同族：**只测纯函数判据抓不到接线缺口**。

### 关键发现：推翻了原实现的核心假设

原实现走「原生保存对话框」（往地址栏填路径 + 点保存）。真机取证的实际情况是：

```
点「导出为独立 HTML」
  → 出现 #32770 空壳窗口（标题 blob:od://app/<uuid>，子控件数 = 0）
  → 下载停在 ~/Downloads/<uuid>.tmp 不再增长（24279 字节恒定）
```

即 0.24.1 的导出是**浏览器式下载**（blob → Electron `will-download`），
那个窗口是下载宿主窗口，**不是**可供 Win32/UIA 驱动的保存对话框。
所以老路线永远等不到产物。

### 正解（真机复现成功的路径）

```
1. CDP: Page.setDownloadBehavior({ behavior:'allow', downloadPath: 项目根 })
2. 点工具栏「导出」（aria-label=导出）
3. 点菜单项「导出为独立 HTML」/「下载为 .zip」
4. 文件直接落盘到项目根，无需任何对话框交互
```

同时把 `saveViaNativeDialog` 降级为**可选兜底**（短预算试一次；失败不 return，
继续走「等产物落盘」——那才是唯一成败判据）。这一步很关键：
真实的正常路径上根本不弹对话框，若把它当必需步骤，反而会把最常见的成功路径拦死。

### 接线范围

- `cdp.ts` 新增 `setDownloadDir`（`Page.` 与 `Browser.` 两个协议版都发，幂等）
- `export.ts` 把它设为**点菜单项之前**的必要步骤（点完才开始下载，那时再设就晚了）
- `run.ts` 在 `finished` 终态调用 `exportArtifact`（导出失败**不改终态**，只写进 summary）
- `exportKind` 贯通五处传递链：schema → adapter → task → context → handlers

---

## 缺陷 ①：首页入口漂移 → `selector_drift` 硬失败

**现象**：任务在连接阶段硬失败，`endReason=selector_drift`，而页面其实完全正常。

**根因**：首页 `od://app/` 与会话页 `.../files/` 是**两个互斥形态**——

| 页面 | `home-hero` | `workspace-home-chrome` | `working-dir-trigger` |
|---|---|---|---|
| 首页 `od://app/` | 1 | **0** | 1 |
| 会话页 `.../files/` | **0** | 1 | **0** |

`run.ts` 的流程是「先 `ensureHomePage()` 回首页，再跑布局守卫」。
`OPEN_DESIGN_HOME_ENTRY_SELECTOR` 原本只有 `entry-view-home` / `entry-nav-home`——
这两个**只在首页存在**，会话页点空气 → 回不了首页 → 守卫在**会话页**上检查 →
`title` 恒 0 → 硬失败。

**修复**：补 `workspace-home-chrome`（会话页唯一能回首页的入口，实测 aria=`主页`、
点击后 URL 变 `od://app/`）。同时固化 `title` 的「**仅首页命中**」语义——
它被 `ensureHomePage` 用作「是否已在首页」的判据，一旦混入会话页也存在的键，
停留会话页会被误判成已在首页，后续首页专属控件必然 0 命中。

---

## 缺陷 ②：失败态未接线 → 失败界面上空等到时限

**现象**：UI 已显示「运行失败 / AI 未能生成内容，请重新发起任务」，
适配器日志仍持续输出 `running；运行证据=send_starting；稳定轮=0`，**空等 10 分钟以上**直到时限。

**根因**：`liveness.ts` 的 `errorText → kind:"failed"` 判据**早已齐备**（含单测），
但采集链三层从未接线：

| 层 | 状态 |
|---|---|
| `liveness.ts` 类型 `errorText` | 有 |
| `liveness.ts` `evidenceOf` → `error_text` | 有 |
| `liveness.ts` 判定 → `kind="failed"` | 有（且有单测） |
| `cdp.ts` `OpenDesignPollSnapshot` | **缺** |
| `cdp.ts` `pollExpression` 采集 | **缺** |
| `run.ts` poll 组装传递 | **缺** |

**修复**：补齐三层 + 同步 `fake-cdp` 桩（桩漏字段会让真机的 failed 判定在测试里永远走不到）。
真机取证用产品自己的钩子：`chat-run-error-card` / `chat-run-error-description`。

---

## 缺陷 ③：工作目录回读假失败（`title` 形态判据）

**现象**：`reason=readback；原生对话框已确认，但工作目录回读为「工作目录」，与目标不一致`
——而绑定**其实已经成功**（`app-config.json` 的 `recentLinkedDirs` 已含目标且列首位）。

**根因（两层）**：

1. `working-dir-trigger` 的 `title` 属性**语义随状态变化**：
   - 空态：`title` 是 tooltip「让 Agent 可读取该本地目录（不会导入到 Design Files）」
   - 已绑定态：`title` 才是**完整路径**，而 `innerText` 只给末段目录名

   原判据只读 `innerText`，于是只能靠 `recentLinkedDirs` 旁证兜底。

2. 而 `app-config.json` **异步落盘**——真机时序实测：

   | 事件 | 时刻 |
   |---|---|
   | 原生对话框完成 | 08:30:30.6 |
   | 回读 3 次（预算 4×700ms） | 08:30:31.3 ~ 32.7 |
   | 判 `readback` 失败 | 08:30:33.1 |
   | **`app-config.json` 实际写盘** | **08:30:38.8（晚 8.2 秒）** |

   旁证始终是旧值 → **绑定成功却判失败**。

**修复**：`title` **像路径**才采信（盘符 / 正斜杠 / UNC），空态回落 `innerText`。
这样完整路径能自证，不再依赖落盘时序。

---

## 验证

| 项 | 结果 |
|---|---|
| typecheck | exit 0 |
| opendesign 全族 | 9 文件 **129 passed** |
| `fake-cdp` 全部 8 个消费方 | **115 passed** |
| lint | exit 0 |
| 三处修复的**反证** | 各自回滚后对应用例转红（证明测试有辨别力） |
| 导出链路**真机端到端** | zip / html 各跑两轮全通过 |

导出真机验证（走**真实实现**，非手搓探针）：

**zip** →
```
已把下载目录指向：D:\Trae项目\AI游戏\Minecraft
未出现原生保存对话框 —— 按浏览器式下载处理，改等产物直接落盘
导出产物已落地：...\Website-Clone.zip
已解压 Website-Clone.zip，入口 minecraft-promo.html
→ {"ok": true, "artifact": "Website-Clone.zip", "entry": "minecraft-promo.html"}
```
产物校验：魔数 `504b0304`、`testzip()` 无损坏、3 条目
（`minecraft-promo.html` 178065B + `DESIGN-HANDOFF.md` 6980B + `DESIGN-MANIFEST.json` 5081B）。

**html** →
```
导出产物已落地：...\minecraft-promo.html
→ {"ok": true, "artifact": "minecraft-promo.html"}
```

---

## 升级说明

无破坏性变更。要启用自动导出，在 `run_task` 里加可选参数：

```
run_task --agent opendesign --project-path <目录> --export-kind zip|html
```

不加 `exportKind` 时行为与 0.9.6 完全一致（不自动导出）。

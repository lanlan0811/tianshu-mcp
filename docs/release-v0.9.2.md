# v0.9.2 — ZCode 真机冒烟修复版

> **ZCode 适配器回归修复版**：两轮真机冒烟（代码生成 + 多轮新建任务）共暴露 **5 个缺陷**，
> 全部与 ZCode 3.14.4 的**模型标识语义**和**点击可点性判据**有关。其中 3 个会让特定模型
> **完全无法派单**，1 个是「点击返回成功但页面纹丝不动」的**假成功**。

**本版无破坏性变更、工具面不变（仍 8 个工具），升级无需改调用方。**

---

## 背景

ZCode 的模型标识有三套**互不推导**的语义，适配器此前多处按「`供应商/模型`」约定硬切或硬比，
于是在特定模型上 fail-closed：

| 语义 | 真机值（本次测试所用模型） |
|---|---|
| 面板可见标签 | `OpenRouter/inclusionai/ling-3.0-flash-sante:free`（可能带 `分组名/` 前缀） |
| 面板分组显示名 | `OpenRouter`（用户可见）/ `openrouter`（testid 段） |
| `供应商/模型` 参数段 | `openrouter` + `inclusionai/ling-3.0-flash-sante:free` |

关键点：**模型名自身可含 `/` 与 `:`**（OpenRouter 的免费模型后缀就是 `:free`，
模型 id 里还有 `inclusionai/`），而分组显示名与参数段**没有对应关系**。

---

## 修复

### ZCode 模型标识（4 个缺陷）

| 缺陷 | 现象与根因 | 处置 |
|---|---|---|
| **模型名含冒号时适配器完全不可用** | `data-model-current-value` 格式是 `custom:<provider>:<urlencoded-model>`，旧实现用 `decodeURIComponent(v).split(":").at(-1)` 取模型名，**假设模型名不含冒号**。真机反例：`custom:openrouter:inclusionai%2Fling-3.0-flash-sante%3Afree` 解码后末段被切成 `free`，与可见标签不符 → 抛「当前模型属性与可见标签冲突」，**任何 `run_task` 都失败** | 改为按 `<kind>:<provider>:` **前缀剥离**（只切前两段，第三段整段保留），与属性格式一一对应；剥离结果与可见标签一致才采信，否则回退旧逻辑参与校验（不放宽冲突检测） |
| **面板分组名与参数段不一致 → `model_unavailable`** | 用户按面板传 `cline-pass/deepseek-v4.1-flash`，但该模型所属分组显示名是 `cline`（testid `...registry-provider:new-provider-2`）——`provider` 段与分组名**两段都匹配不上** | 供应商精确匹配失败时**枚举可见分组逐个 hover** 并试匹配模型名；模型匹配值优先用**完整原始串**，再退到 `spec.model`；回读校验接受完整串 / 仅 model 段 / 仅 provider 段三种形态 |
| **切换成功后仍判 `model_mismatch`** | 面板可见标签把**分组显示名**拼在模型名前（`.composer-provider-prefix` = `cline/`），旧回读只认完整候选串 → `display=cline/cline-pass/deepseek-v4.1-flash` 三候选全不中。**供应商回退与模型选中都已走通，却被最后一道校验判死** | 新增 `uiModelNameMatches()`：先精确命中，失败则**剥一层** `首段/` 前缀再比；等待条件与最终校验共用它。只剥一层——多剥会把结构上不相关的名字算命中 |
| **三段式模型参数被参数校验直接拒绝** | 模型名可含 `/`，按「面板分组 + 模型显示名」传参必然三段式（`openrouter/inclusionai/ling-3.0-flash-sante:free`），而 `parseZcodeModel` 要求 `split("/").length === 2` → 立即报「应为 供应商/模型」，**该模型连参数校验都过不了** | 切分基准改为**首个 `/`**（之前是 provider、之后整段是 model），与面板「分组 / 模型」两个字段一一对应；`/x`、`x/`、无斜杠仍拒绝 |

### ZCode 点击可点性（1 个缺陷）

| 缺陷 | 现象与根因 | 处置 |
|---|---|---|
| **顶部新建任务按钮点击假成功** | 连续 3 轮冒烟**每轮**都打出「顶部新建任务按钮未建立草稿（clicked=true）；回退侧栏新建任务按钮」，全靠回退兜底才没失败。根因：`conversation-new-task` 挂在页面滚动容器底部（真机 y=2474，视口高 640），宽高都 >0 所以旧判据认为「可见」，鼠标事件发到**视口外**被 Chromium 静默丢弃，而 `click()` 仍返回 `true` | 通用 `click()` 增加与 `probeProjectTrigger` 同源的**可点性判据**：视口裁剪（中心点必须落在 `innerWidth/innerHeight` 内）+ `elementFromPoint` 命中自身或其后代；不通过则返回 `false` 且**不发任何鼠标事件**，让调用方走回退而不是空等 |

**真机复验**：修复后同场景 warn 消失，单轮新建任务耗时 **67–73s → 46s**。

---

## 真机验证

两轮冒烟均在 ZCode 3.14.4.7912（Windows）真机执行：

**第一轮：代码生成闭环**

- 从「当前选中含冒号模型」状态切到目标模型并派单 → `succeeded`
- 产物：`zcode-accept.txt`，内容逐字正确

**第二轮：3 轮新建任务（openrouter / inclusionai/ling-3.0-flash-sante:free）**

| 轮次 | taskId | 结果 | 产物 |
|---|---|---|---|
| 1 | `tsk_20261008231635_614c75` | `succeeded` | `docs/minecraft-intro.md`（2285 B） |
| 2 | `tsk_20261008231843_39fcec` | `succeeded` | `docs/minecraft-gameplay.md`（2642 B） |
| 3 | `tsk_20261008232011_6977cb` | `succeeded` | `docs/minecraft-ecosystem.md`（3472 B） |
| 复验 | `tsk_20261008232829_f3f922` | `succeeded` | `docs/verify-round.md` |

三轮**会话 ID 互异**（新建任务隔离正确），产物逐条命中任务书要求。

---

## 测试

- 新增回归锁 **7 条**：三段式解析及其边界（4）、回读前缀剥离的命中与不越界（2）、点击可点性三态（3）
- **全部经反证验证**：回滚修复 → 精确变红，且只有目标用例变红
- 全量：**1682 passed / 12 skipped**（1696）
- `typecheck` exit 0

---

## 升级

```bash
npm install -g tianshu-mcp@0.9.2
```

工具面与 0.9.1 完全一致（8 个工具），无需修改调用方代码。

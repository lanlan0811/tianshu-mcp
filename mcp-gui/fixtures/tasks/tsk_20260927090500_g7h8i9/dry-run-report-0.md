# 干跑静态分析报告 · 第 0 轮

- 任务：`tsk_20260927090500_g7h8i9`
- 项目：`<项目目录>\api-service`
- 结论：**静态分析完成**（未改动源码，不消耗验收轮次）

## 待补校验

| 位置 | 现状 | 建议 |
|---|---|---|
| `src/routes/orders.ts:24` | `page` 未做正整数校验 | 增加 `z.coerce.number().int().min(1)` |
| `src/routes/orders.ts:25` | `pageSize` 未设上限 | 增加 `.max(100)` 并给默认值 20 |
| `src/routes/orders.ts:31` | `sort` 直接拼接进 SQL 片段 | 改为白名单映射 |

## 静态信号

- todo 1 / consoleDebug 0 / commentedBlock 0 / secretLike 0
- 相关文件：`src/routes/orders.ts`、`src/routes/__tests__/orders.test.ts`

## 说明

干跑报告与常规 `report-<round>.*` **分开存放**：两者结论口径不同
（静态分析 vs 真实命令验收），不可互相替代。
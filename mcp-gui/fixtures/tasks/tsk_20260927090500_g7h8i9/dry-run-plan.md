# 干跑计划 · `/orders` 分页参数校验

> 本文件由干跑任务渲染，供后续正式任务作为 `planDoc` 复用。

## 目标

为 `/orders` 接口补齐分页参数校验，并补充单元测试。

## 步骤

1. 在 `src/routes/orders.ts` 引入 zod 参数校验；
2. `page` 校验为正整数（默认 1）；
3. `pageSize` 校验为 1..100（默认 20）；
4. `sort` 改为白名单映射，禁止直接拼接；
5. 在 `src/routes/__tests__/orders.test.ts` 补充 6 条边界用例。

## 验收建议

- `npm run build`
- `npm run lint`
- `npm test`
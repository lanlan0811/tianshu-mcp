# 删除 npm 包旧版本教程（网页方式，推荐）

适用场景：删除 `tianshu-mcp@0.1.1`（带 .map 的旧版），因为命令行 `npm unpublish` 会被你的 Granular token 安全策略拦下（"Granular access tokens that bypass two-factor authentication may not perform this action"）。

> 网页操作走你账号的完整登录态（含 2FA），不受 token 限制，是最可靠的方式。

## 步骤

### 1. 打开包页面

浏览器访问：https://www.npmjs.com/package/tianshu-mcp

### 2. 确认已登录

页面右上角应显示你的头像/用户名 `lotteai`。
若未登录，点右上角 **Sign in**，用 npmjs 账号 + 两步验证登录。

### 3. 进入 Versions 页

在包主页点 **Versions** 标签（在包名 `tianshu-mcp` 下方的导航栏里，通常在 "Overview / Readme / Versions" 这一排）。

你会看到版本列表：
- `0.1.2`（latest，无 .map —— **保留**）
- `0.1.1`（带 .map 的旧版 —— **删除这个**）

### 4. 删除 0.1.1

在 `0.1.1` 那一行，右侧找到 **垃圾桶图标 / Delete 按钮**，点击。

npmjs 会弹确认框，可能要求：
- 输入包名 `tianshu-mcp` 确认；
- 或再次输入你的账号密码 / 2FA 验证码。

按提示确认即可。

### 5. 验证

删除后刷新 Versions 页，应只剩 `0.1.2`。

也可以在终端验证：
```bash
npm view tianshu-mcp versions --registry=https://registry.npmjs.org
# 应输出 [ '0.1.2' ]
```

---

## 备选：命令行删除（如果网页不行）

需要生成一个**不绕过 2FA 的 token**（在 npmjs Access Tokens 里，类型选会触发 2FA 校验的），或者直接改用经典 `npm login` 的会话（带 2FA 的 auth token）：

```bash
npm unpublish tianshu-mcp@0.1.1 --registry=https://registry.npmjs.org
```

若仍报 403，说明当前凭据被 npmjs 判定为"绕过 2FA 的 granular token"，npmjs 已禁止此类 token 做删除/修改等敏感操作——此时只能用网页。

## 注意事项

- **`0.1.2` 是 `latest`，不要删它**——删了会让包回到未发布状态并触发 24 小时锁定。
- 删除 `0.1.1` 不影响任何已安装用户（`npx -y tianshu-mcp` 拿到的是 latest = 0.1.2）。
- npmjs 对**已发布超过 72 小时**的版本不允许直接删除（只能 deprecate），若出现"cannot delete because it was published more than 72 hours ago"，请告诉我，改用 deprecate 方案。

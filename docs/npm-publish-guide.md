# npm 发布教程（如何提供 token 并完成 DoD #7）

本仓库 `tianshu-mcp`（v0.1.1）已通过全部本地门禁与三平台 CI，`npm pack` 产物验证可安装、可作为 MCP server 被拉起。只差**发布到 npmjs registry** 这一动作（需要你的账号凭据）。以下是你（或任何有 npmjs 账号的人）可执行的步骤；发布后我即可补 `npx -y tianshu-mcp` 拉起连通证据。

## 方式 A：命令行一次性登录（推荐，最简单）

在**本项目机器**的任意终端执行：

```bash
npm login --registry=https://registry.npmjs.org
```

按提示输入 npmjs 用户名 / 密码 / 邮箱 + **一次性验证码**（npm 会发到你账号邮箱或 Authenticator）。成功后 `~/.npmrc` 会写入 `//registry.npmjs.org/:_authToken=…`。

> 注意：本机 `~/.npmrc` 现在写着 `registry=https://registry.npmmirror.com`。`npm login` 指定 `--registry` 会把登录写入 npmjs 段，不冲突。**发布时务必带 `--registry=https://registry.npmjs.org`**。

## 方式 B：生成 Access Token（适合不想存密码）

1. 打开 https://www.npmjs.com → 登录 → 右上角头像 → **Access Tokens** → **Generate New Token**。
2. 类型选 **Granular** 或 **Publish**（仅发布权限足够）。
3. 复制生成的 `npm_xxxx` token，然后在本机：
   ```bash
   # 临时会话使用（不落盘）：
   export NODE_AUTH_TOKEN=npm_xxxx
   npm publish --registry=https://registry.npmjs.org
   # 或写入 ~/.npmrc：
   # //registry.npmjs.org/:_authToken=npm_xxxx
   ```

## 发布命令（token 就绪后）

```bash
cd D:\Trae项目\tianshu-mcp
npm run typecheck && npm run lint && npm test && npm run build   # 门禁
npm publish --registry=https://registry.npmjs.org --access public
```

- 包名 `tianshu-mcp` 已在 npmjs 确认**未被占用**，无需回退 `tianshu-dev-agents-mcp`。
- 发布版本 = `package.json` 的 `0.1.1`（与 git tag `v0.1.1`、Release draft 一致）。

## 发布后需要补的证据（DoD #7 收尾）

把 token 配置好告诉我（或你直接执行上面命令后告诉我），我会执行并留存：

```bash
# 1) registry 可查到正确版本
npm view tianshu-mcp version --registry=https://registry.npmjs.org
# 2) 全新临时目录 npx 拉起并做协议冒烟
mkdir /tmp/npx-smoke && cd /tmp/npx-smoke
npx -y tianshu-mcp   # 由官方 SDK client 连上 → initialize → tools/list(8) → get_profiles
```

## 常见问题

| 问题 | 处理 |
|---|---|
| `ENEEDAUTH` / `401` | token 未生效：检查 `npm whoami --registry=https://registry.npmjs.org` 返回你的用户名 |
| 想用 npmmirror 加速但发布到 npmjs | 镜像只读，发布必须走 `--registry=https://registry.npmjs.org` |
| 包名被占 | 换 `tianshu-dev-agents-mcp` 并同步改 package.json/README |

---

## Gitee 发行版（镜像仓库需单独创建）

GitHub Actions 的 `release.yml` 只作用于 GitHub；Gitee 作为镜像仓库**不会**自动生成发行版，
历史上出现过「Gitee 只有 tag、没有发行版」的不一致。现由 `scripts/gitee-release.mjs` 幂等补齐。

### 一次性配置（让 CI 自动建 Gitee 发行版）

1. Gitee → 设置 → 私人令牌 → 生成新令牌，至少勾选 **projects** 权限，复制令牌。
2. GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret：
   名称 `GITEE_TOKEN`，值为上一步令牌。

配置后，推 `v*` tag 时 `release.yml` 末尾会自动创建/更新对应 Gitee 发行版（正文取
`docs/release-v<版本>.md`）。未配置 `GITEE_TOKEN` 时该步骤会**明确提示并跳过**，不会让工作流失败。

### 手动补建某个版本

```bash
cd D:\Trae项目	ianshu-mcp
GITEE_TOKEN=<你的私人令牌> node scripts/gitee-release.mjs 0.3.0
# 正文默认取 docs/release-v0.3.0.md；也可显式指定：node scripts/gitee-release.mjs 0.3.0 docs/release-v0.3.0.md
```

脚本行为：已存在同 tag 发行版则**更新**正文，不存在则**创建**（`target_commitish` 默认 `master`，
可用 `GITEE_BRANCH` 覆盖）。

### 发布正文的构成

GitHub 与 Gitee 的发行版正文均取 `docs/release-v<版本>.md`，并在末尾自动追加 `Full Changelog`
比较链接。因此**发布前务必先写好该文档**，否则正文会退化为仅含 Full Changelog。

# Cloudflare Workers 版本

本目录是 static-site-showcase 的 **Cloudflare Workers 独立部署变体**（Hono + D1 + R2），
与仓库根目录的 Node.js 版本（Express + SQLite + Docker）**并存且互不影响**。
Node 版的全部源码、测试、Docker 与部署脚本保持原样，不依赖本目录。

## 与 Node 版的功能差异

| 能力 | Node 版 | Workers 版 |
| --- | --- | --- |
| 数据库 | 本地 SQLite（node:sqlite） | Cloudflare D1（表结构一致） |
| 站点/品牌文件 | 本地文件系统 | R2 对象存储（`sites/`、`branding/` 前缀） |
| 密码哈希 | scrypt | PBKDF2-SHA256（Web Crypto，默认 100,000 次迭代） |
| ZIP 单文件上传上限 | 1–200 MiB | **1–64 MiB**（Cloudflare 请求体与 isolate 内存约束），默认仍 50 MiB |
| ZIP 解压总量上限 | 200 MiB | **48 MiB**（isolate 内存约束）；单文件 25 MiB、2000 条目、压缩比 250 不变 |
| 登录失败冷却 | 进程内计数，全局有效 | 每个 isolate 独立计数，强度略低 |
| 部署目标 | 自有服务器 Docker | Cloudflare Workers（全球边缘） |

其余功能（登录双提交 CSRF、会话管理、账号体系、ZIP/粘贴代码上传、后台设置上传上限、
上传进度条、源码浏览、ZIP 下载、Markdown 页面、CSP 沙箱、敏感文件过滤）语义与 Node 版一致。

**数据不可迁移**：两版密码哈希算法不兼容，且 Workers 版使用独立 D1——首次部署会创建全新的
管理员与空数据，不从 Node 版导入。

## 前置条件

- Cloudflare 账号，且 **Workers 付费计划**（$5/月起）。免费计划的 10ms CPU 限制
  跑不动 PBKDF2 登录验证；如必须使用免费计划，把 `wrangler.jsonc` 中
  `PBKDF2_ITERATIONS` 调低到 `25000` 左右并自行评估安全性。
- Node.js 22.13+（Windows / Linux / macOS 均可，wrangler 会自动匹配 workerd 平台包）。
- 前端改动永远在根目录 `public/`、`showcase/` 进行，然后 `npm run sync-assets` 同步到本目录
  `assets/`（该目录由脚本生成，已加入 `.gitignore`）。

## 首次部署

```bash
cd cloudflare
npm install
npm run sync-assets

# 1. 创建 D1 数据库（把输出的 database_id 填入 wrangler.jsonc）
npx wrangler d1 create static-site-showcase
npx wrangler d1 execute static-site-showcase --remote --file schema.sql

# 2. 创建 R2 桶
npx wrangler r2 bucket create static-site-showcase

# 3. 配置秘密
npx wrangler secret put LOGIN_CSRF_SECRET   # 任意 32+ 字节随机串
npx wrangler secret put ADMIN_USERNAME      # 首次管理员用户名
npx wrangler secret put ADMIN_PASSWORD      # 首次管理员密码（必填，无默认值）

# 4. 部署
npm run deploy
```

`wrangler.jsonc` 中 `database_id` 替换为第 1 步的输出。绑定自定义域名在
Cloudflare 控制台的 Worker → Settings → Domains & Routes 中添加；平台 Cookie 使用
`__Host-` 前缀并恒为 Secure，必须经 HTTPS 域名访问。

## 本地开发与验证

```bash
npm run dev          # wrangler dev，本地模拟 D1/R2/Assets，需先创建 .dev.vars
node scripts/integration.js http://127.0.0.1:8787
```

`.dev.vars` 参考格式（已被 `.gitignore` 排除，生产用 `wrangler secret put`）：

```text
LOGIN_CSRF_SECRET=dev-only-32-bytes-random-secret
ADMIN_USERNAME=dev_admin
ADMIN_PASSWORD=dev-test-password-123456
```

集成脚本覆盖：登录双提交 CSRF、上传限制读取与动态修改、ZIP 上传/沙箱访问/413、
源码浏览、ZIP 下载、粘贴代码、页面 CRUD、编辑者权限与 CSRF 拒绝、后台静态资源鉴权。

## 常用运维

```bash
npm run deploy       # 同步前端资源并部署
npm run dry-run      # 本地构建校验（CI 使用）
npx wrangler tail    # 查看实时日志
npx wrangler d1 execute static-site-showcase --remote --command "SELECT COUNT(*) FROM sites"
```

## 更新

拉取新版本源码后：

```bash
git pull
npm install
npm run deploy
```

`schema.sql` 只需在表结构变更时重新执行（当前使用 `CREATE TABLE IF NOT EXISTS`，
可安全重复执行）。

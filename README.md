# test3 · 专业服务账号与商务线索工作台

CODEX-001 实现的是一个中文内部账号管理 MVP：管理员登录后登记并批准来源，单条或 CSV 导入账号，服务端校验主页链接、去重并写入 PostgreSQL，随后在账号库筛选、查看详情和查看导入结果。

本轮只实现账号资料导入闭环，不实现联系方式提取、数据导出、平台爬虫或自动营销。四个平台当前是账号类型和 URL 校验边界，不代表已接通真实平台 API。

## 环境要求

- Node.js 24.19.0 或更高版本
- pnpm 11.19.0
- PostgreSQL 17（推荐使用仓库内的 Compose 配置）

## 本地启动

以下命令不会覆盖已有 `.env` 或本地管理员凭据：

```bash
pnpm install --frozen-lockfile
pnpm setup:local
docker compose up -d db
pnpm db:generate
pnpm db:migrate
pnpm admin:create
pnpm db:seed:demo
pnpm dev
```

浏览器打开 <http://127.0.0.1:3000>。管理员邮箱和随机密码保存在 `.local/admin-credentials.json`，该文件已加入 `.gitignore`，不会写入 README 或日志。

`db:seed:demo` 只允许 `APP_MODE=demo`，只创建明确标注的虚构演示来源；生产或真实运行模式会拒绝执行。生产启动不会自动 seed。

## 功能路径

1. 使用管理员凭据登录。
2. 进入“数据来源”，创建来源并填写录入依据，点击“批准录入”。
3. 在“添加账号”进行单条录入，或在“导入中心”下载模板、预览 CSV 后确认导入。
4. 在“账号库”使用“搜索已入库账号”、平台、服务标签和来源筛选。
5. 打开账号详情查看来源链接、标准化链接和可编辑的业务资料；主页只在主动点击后打开。

CSV 模板列顺序为：

```text
platform,nativeId,displayName,profileUrl,organization,serviceTags,region,sourceUrl
```

使用 `|` 分隔多个服务标签；单批最多 500 条数据行、2 MiB。固定验收夹具位于 `tests/fixtures/accounts-90.csv`。

## 检查命令

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm build
```

集成测试要求单独的、明确命名的测试数据库，通过 `TEST_DATABASE_URL` 提供；测试代码会拒绝非 `test`、`ci` 或 `e2e` 数据库。没有 Docker 或测试 PostgreSQL 时，集成测试会标记为 skipped，不能据此宣称通过。E2E 需要额外提供 `E2E_ADMIN_EMAIL` 和 `E2E_ADMIN_PASSWORD`。

## 安全边界

- 会话 token 只在 HttpOnly Cookie 中传递，数据库仅保存 SHA-256 哈希，时效 8 小时。
- 所有业务 API 服务端鉴权；写请求校验 Origin。
- 来源能力默认关闭；撤销、过期和缺少依据的来源不能录入。
- 主页 URL 只做本地格式校验，不发起服务器外联、不展开短链接、不抓取用户输入 URL。
- 去重优先使用平台 + 稳定 ID，其次使用平台 + 标准化主页 URL；不按昵称或跨平台相似度合并。
- `.env`、真实密钥、真实联系人、数据库备份、日志和导出文件不得提交到仓库。

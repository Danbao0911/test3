# test3 · 专业服务账号与商务线索工作台

当前包含 CODEX-001 账号导入和 CODEX-002 商务联系候选核验：管理员登录、来源审批、账号录入/CSV 导入、规则提取、逐项证据与人工审核，数据保存在 PostgreSQL。

联系处理暂仅开放隔离演示/测试模式，生产接口主动拒绝联系提取和批准，须等待 T07 数据生命周期剩余验收后再开放。账号收藏/跟进、跨账号关联审核和受控导出已在隔离环境提供。平台接入页展示四个平台的实际关闭状态，管理员可核对本地来源条件；尚无平台真实 API 调用、爬虫或自动营销。见 [能力与许可登记](docs/SOURCE_REGISTER.md) 和 [T08 报告](docs/CODEX-002-T08-REPORT.md)。

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
6. 管理员在来源行“编辑策略”中填写联系处理依据，分别开启“允许联系提取”和“允许保留最小证据文本”，设定有效天数。
7. 在账号详情点击“商务联系与证据”，填写字段证据地址、取得时间、字段位置及文本，提取待审核候选。服务端不访问链接，完整输入不入库。
8. 在“联系审核”逐项核对证据，分别确认归属及商务用途、填写原因后批准；支持驳回/失效，审核历史保留。来源变更后旧版本不再可用。
9. 在“账号关联审核”查看同平台精确去重之外的人工关联候选；共享联系只会进入待核验状态，确认与撤销均由审核员/管理员执行，来源撤销或到期后关联自动标为不可用。
10. 管理员可在“受控导出”生成允许字段的一次性链接；来源字段许可、当前策略、人工审核、期限及抑制均在下载时复核，具体限制见 [T07-R1 报告](docs/CODEX-002-T07-R1-REPORT.md)。
11. 在“平台接入”查看能力矩阵；管理员选择来源核对缺少的条件。核对仅检查本地策略，不发起平台请求，也不会将人工来源自动升级为官方 API 授权。

演示文本示例（每行一个明确字段）：

```text
商务邮箱：business@example.com
商务微信：demo_business
企业电话：+1 202 555 0100
官网联系页：https://example.com/contact
商务预约：https://example.com/book
```

证据地址也必须使用 `example.com/net/org`，账号主页须为 `https://example.com/demo/...`。文本上限 5000 字、请求体上限 32 KiB、单次最多 20 个候选。第三方/广告/评论上下文不生成归属候选；缺失信息保持为空。当前仅支持获准保留文本的字段证据，不支持引用式证据。

## 成员角色

管理员可管理来源；管理员和审核员可维护账号、提取及审核；只读成员不能写入，联系值脱敏，API 不返回证据正文及审核原因。

`pnpm admin:create` 使用本地随机凭据初始化管理员。创建其他成员时，由受信任的运维在仓库外准备权限为 `600` 的 JSON 凭据文件（仅 `email`、至少 12 字符的 `password`），执行：

```bash
pnpm user:create REVIEWER /absolute/path/reviewer-credentials.json
pnpm user:create VIEWER /absolute/path/viewer-credentials.json
```

已有邮箱不覆盖。无公开注册或成员管理 API。新建用户默认只读；迁移将旧版本仅有的管理员账户保留为 ADMIN。

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

集成测试要求单独的、明确命名的测试数据库，通过 `TEST_DATABASE_URL`、`TEST_DATABASE_NAME`、`TEST_DATABASE_MODE=isolated` 和 `TEST_RUN_ID` 提供，并且 `DATABASE_URL` 必须逐字相同；测试代码拒绝默认库、生产库、模糊的 `ci` 子串、附加连接参数、非白名单主机和非当前运行 ID 的数据库。连接后还检查角色不能是超级用户、不能创建数据库/角色、绕过行权限或继承其他角色。配置缺失或 PostgreSQL 不可用直接失败，不会 skip。CI 为 verify 和 E2E 创建不同临时数据库，并使用仅获准操作本轮库的非特权角色。E2E 还需临时 `E2E_ADMIN_EMAIL` 和 `E2E_ADMIN_PASSWORD`，且不会复用既有开发服务器。

本地测试需先由数据库管理员创建类似 `test3_test_local001` 的专用库和非特权角色，仅给该库 CONNECT/CREATE、public schema 的 USAGE/CREATE；设置 `TEST_RUN_ID=local001`、完整测试变量与 `APP_MODE=test`。在迁移前运行 `pnpm test:unit` 和 `pnpm exec tsx scripts/verify-test-database.ts`。不要指向 Compose 的演示库，也不要用超级用户跑测试。CI 的角色初始化脚本仅供全新临时 CI 服务使用。

运行服务必须设置完整可信源 `APP_ORIGIN`，并显式选择 `APP_MODE=demo|test|production`。演示/测试模式只接受 `DEMO` 来源和合成 `example.com/demo/...` 数据；生产模式拒绝演示与测试数据库及演示来源。

## 安全边界

- 会话 token 只在 HttpOnly Cookie 中传递，数据库仅保存 SHA-256 哈希，时效 8 小时。
- 所有业务 API 服务端鉴权；写请求校验 Origin。
- 来源能力默认关闭；撤销、过期和缺少依据的来源不能录入。
- 联系提取与证据保留权限独立于账号录入；来源行锁串行化撤销与写入。策略版本变化、来源或证据到期会立即使联系项不可用。
- 原文候选、证据、审核与最小化审计在事务中写入；并发审核使用版本冲突检测，不做静默覆盖。
- 主页 URL 只做本地格式校验，不发起服务器外联、不展开短链接、不抓取用户输入 URL。
- 去重优先使用平台 + 稳定 ID，其次使用平台 + 标准化主页 URL；不按昵称或跨平台相似度合并。
- `.env`、真实密钥、真实联系人、数据库备份、日志和导出文件不得提交到仓库。

完整范围、迁移与回滚说明见 [CODEX-002 报告](docs/CODEX-002-REPORT.md)。当前不是完整 v0.1，也尚未满足真实数据上线条件。

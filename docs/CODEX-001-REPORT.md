# CODEX-001 交付报告

## 状态

CODEX-001 已完成代码、迁移、单元测试、真实 PostgreSQL 集成测试和浏览器 E2E 验收。后续 R1 审查修复记录见 [`docs/CODEX-001-R1-REPORT.md`](./CODEX-001-R1-REPORT.md)。

## 分支与提交

- 分支：`codex/001-account-import`
- 初始基线：`33d3786`
- CODEX-001 实现提交：`9b5913c`
- R1 修复提交：`dcd5e62`
- PR：[#1](https://github.com/Danbao0911/test3/pull/1)

## 已实现

- 管理员登录、8 小时 HttpOnly 会话、退出、过期校验和数据库级账号维度登录限流。
- DRAFT / APPROVED / REVOKED 来源登记，依据说明、失效时间和服务端录入权限复核。
- 单条账号录入、CSV 预览、逐行失败结果、事务导入、幂等键重放和幂等内容冲突保护。
- HTTPS、精确平台域名、账号主页路径、私有地址、凭据、端口和跟踪参数校验；服务端不访问用户输入链接。
- 平台 + nativeId、平台 + 标准化主页 URL 去重；身份冲突不自动合并。
- 账号库分页、关键词/平台/标签/来源筛选，账号和导入详情，来源状态/失效时间管理。
- 显式 demo / test / production 运行模式；演示/测试仅接受 `DEMO` 与合成数据，生产拒绝演示/测试数据库。
- CI 使用独立的本轮 PostgreSQL 数据库；verify 和 E2E 分别运行，缺少隔离配置会失败而非 skip。

## 数据库迁移

- `prisma/migrations/20260917230000_init/migration.sql`：业务基础表、枚举、唯一约束、索引和外键。
- `prisma/migrations/20260918000000_login_throttle/migration.sql`：账号维度登录限流窗口表。

## 本地检查

运行环境为 Node.js 24.19.0、pnpm 11.19.0。

| 命令 | 结果 |
| --- | --- |
| `pnpm setup:local` | exit 0 |
| `pnpm db:generate` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test:unit` | exit 0，3 个文件、9 个断言通过 |
| `pnpm test:integration` | exit 1，缺少 `TEST_DATABASE_URL/NAME/MODE/RUN_ID` 时被 R01 保护主动拒绝；不是 skip |
| `pnpm build` | 本地 exit 0，CI 在隔离 test DB 上 exit 0 |
| `pnpm test:e2e` | 由 CI 在隔离 e2e DB 上 exit 0 |

## R1 整改定位与证据

| 审查项 | 代码位置 | 测试/证据 |
| --- | --- | --- |
| R01 DB 安全 | `src/lib/runtime-config.ts`、`tests/helpers/test-database.ts`、`tests/unit/test-database.test.ts` | 默认 `test3`、`financial_prod`、模糊 `financial_ci_prod`、非当前 run ID 均拒绝；集成清理只按本轮创建的精确 ID |
| R02 CI | `.github/workflows/ci.yml`、`playwright.config.ts`、`scripts/setup-local.ts` | [CI run 35256406155](https://github.com/Danbao0911/test3/actions/runs/35256406155)：verify 与 e2e 均 success |
| R03 导入并发/幂等 | `src/lib/import-service.ts`、`src/app/api/accounts/route.ts`、`src/app/api/imports/route.ts` | T04–T11：去重、身份冲突、重放、409、并发、撤销、事务回滚 |
| R04 前端导入状态 | `src/components/imports-page.tsx` | 文件/来源变更清空预览，预览绑定快照；一次操作复用一个 key，重复点击/响应丢失可重试 |
| R05 demo/real | `src/lib/runtime-config.ts`、来源 API、账号/导入服务、导航 | test/e2e 使用 DEMO；服务端拒绝错误类型；导航显示当前模式 |
| R06 URL/空 nativeId | `src/lib/account-normalizer.ts`、`tests/unit/account-normalizer.test.ts` | 路径段、精确 host、IP/IPv6/localhost、凭据、端口、原生 ID 大小写与空白边界 |
| R07 CSV/请求边界 | `src/lib/request.ts`、`src/lib/import-service.ts`、预览/导入 API | T13：BOM、引号逗号、7/9 列行号、malformed、2 MiB、非法 sourceId、contacts 列、25 个身份冲突 |
| R08 真实测试 | `tests/integration/account-import.integration.test.ts`、`tests/e2e/account-import.spec.ts` | T01–T15 全部真实 HTTP；E2E 使用当前创建的唯一来源，不取 `last()` |
| R09 auth | `src/lib/auth.ts`、`src/app/api/auth/login/route.ts`、LoginThrottle 迁移 | Origin 严格匹配；忽略未配置的 forwarded host；数据库锁定的邮箱窗口限流；T02/T15 验证退出与过期 |
| R10 页面/状态 | 三个业务首页 server guard、`src/components/*-page.tsx`、详情页 | 未认证页面服务端 redirect；客户端 API 对 401/网络错误明确提示；来源失效时间显示为关闭 |

## 90 行验收结果

在真实隔离 PostgreSQL 上，固定 `tests/fixtures/accounts-90.csv` 的结果为：

- 首次导入：`total=90, created=60, duplicate=20, invalid=10`。
- 相同 key/内容重放：返回同一 batch，`created=0, duplicate=80, invalid=10`。
- 新 key/同一文件：`created=0, duplicate=80, invalid=10`。
- 两个不同 key 并发：两个批次均为 `0/80/10`，来源账号总数保持 60。
- E2E 在独立 e2e 数据库再次验证首次 `60/20/10`，并验证 X 平台筛选 15 条、详情页可达。

## CI 命令与结果

最新 [CI run 35256406155](https://github.com/Danbao0911/test3/actions/runs/35256406155) 的 verify job 顺序执行并成功：

```text
pnpm install --frozen-lockfile       exit 0
pnpm db:generate                     exit 0
pnpm db:migrate                      exit 0
pnpm lint                            exit 0
pnpm typecheck                       exit 0
pnpm test:unit                       exit 0 (3 files, 9 tests)
pnpm test:integration                exit 0 (15 tests passed, 0 skipped)
pnpm build                           exit 0
```

同一 run 的 e2e job 成功执行依赖安装、迁移、临时管理员初始化、Chromium 安装和 `pnpm test:e2e`（1 test passed）。

## 回滚

代码回滚应由负责人审阅后回退开发分支提交；数据库回滚使用经过审核的逆向迁移或备份恢复。本任务未执行 `prisma migrate reset`、生产删除、强制推送或自动合并。测试清理只删除本轮精确创建的用户、会话、限流键、来源、批次和账号。

## 范围外

联系方式提取、导出、平台爬虫/真实 API、自动营销、审核工作台和跟进流程仍不属于 CODEX-001 / R1 范围，代码没有将这些能力伪装为已接通。

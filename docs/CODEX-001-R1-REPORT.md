# CODEX-001-R1 整改报告

## 结论

R01–R10 已完成并通过真实 CI 验收。整改分支为 `codex/001-account-import`，PR 为 [#1](https://github.com/Danbao0911/test3/pull/1)。最新代码提交为 `dcd5e62`；本报告提交为文档更新，不改变运行逻辑。

## R01–R10 定位

| 项目 | 实现位置 | 验证 |
| --- | --- | --- |
| R01 测试数据库安全 | `src/lib/runtime-config.ts`、`tests/helpers/test-database.ts`、`tests/unit/test-database.test.ts` | 完整目标、模式、run ID、名称边界、主机白名单和 URL 一致性校验；清理按本轮精确 ID |
| R02 CI 可执行性 | `.github/workflows/ci.yml`、`playwright.config.ts`、`scripts/setup-local.ts` | setup pnpm 先于 setup-node cache；隔离 PostgreSQL、迁移、真实 HTTP、真实 Chromium E2E |
| R03 导入幂等/并发 | `src/lib/import-service.ts`、`src/app/api/accounts/route.ts`、`src/app/api/imports/route.ts` | 来源行锁、排序身份锁、P2002/P2034 有界重试；冲突不重试；事务失败不查询失败事务 |
| R04 前端导入状态 | `src/components/imports-page.tsx` | 一次逻辑导入固定 key；文件/来源变更清空预览和结果；过期响应不能覆盖当前快照 |
| R05 demo/real 隔离 | `src/lib/runtime-config.ts`、来源 API、账号/导入服务、`src/components/navigation.tsx` | test/demo 只接受 DEMO 与合成地址；生产拒绝 demo/test DB 和 DEMO 来源；UI 显示模式 |
| R06 URL 与 nativeId | `src/lib/account-normalizer.ts`、`tests/unit/account-normalizer.test.ts` | 精确 host 和路径段；拒绝视频/搜索/短域/额外子路径/IP/IPv6/localhost/凭据/错误端口；空 nativeId 归一为 null |
| R07 CSV 与请求边界 | `src/lib/request.ts`、`src/lib/import-service.ts`、预览/导入 API | file.size 前置检查、完整 body 上限、UTF-8/BOM/引号逗号/精确列数/行号/contacts 列/全量身份冲突 |
| R08 真实测试 | `tests/integration/account-import.integration.test.ts`、`tests/e2e/account-import.spec.ts` | T01–T15 全部真实 HTTP；E2E 使用本轮唯一来源，不使用 `last()` 选择数据 |
| R09 认证与限流 | `src/lib/auth.ts`、`src/app/api/auth/login/route.ts`、`LoginThrottle` 迁移 | 完整 APP_ORIGIN 严格 Origin；不信任未配置 forwarded host；邮箱维度 PostgreSQL 窗口限流 |
| R10 页面与状态 | `src/app/accounts/page.tsx`、`src/app/imports/page.tsx`、`src/app/sources/page.tsx` 及对应组件 | 业务首页 server-side redirect；API 401/403/网络错误有明确提示；来源过期显示关闭 |

## 真实验收结果

最新 [GitHub Actions run 35256406155](https://github.com/Danbao0911/test3/actions/runs/35256406155) 全绿：

- verify：`pnpm install --frozen-lockfile`、`db:generate`、`db:migrate`、`lint`、`typecheck`、`test:unit`、`test:integration`、`build` 全部 exit 0。
- unit：3 个测试文件、9 个断言通过。
- integration：T01–T15 共 15/15 通过，0 skipped；使用本轮专用 `test3_ci_<run_id>` PostgreSQL。
- e2e：1/1 通过；使用不同的本轮专用 `test3_e2e_<run_id>` PostgreSQL，完成临时管理员创建、Chromium 安装、登录、来源批准、导入、平台筛选和详情验收。

固定 90 行夹具结果：

| 场景 | total | created | duplicate | invalid |
| --- | ---: | ---: | ---: | ---: |
| 首次 key | 90 | 60 | 20 | 10 |
| 相同 key/内容重放 | 90 | 0 | 80 | 10 |
| 新 key/同一文件 | 90 | 0 | 80 | 10 |
| 两个不同 key 并发 | 90 | 0 | 80 | 10 |

另外验证了身份冲突 409、single duplicate 的 `existingAccountId`、DRAFT/撤销/过期来源拒绝、401/退出/会话过期、7/9 列行号、BOM、malformed CSV、请求过大、非法来源、contacts 列和事务回滚。

## 本地结果与配置门禁

- 本地 `pnpm setup:local`、`pnpm db:generate`、`pnpm lint`、`pnpm typecheck`、`pnpm test:unit` 均 exit 0。
- 本地 `pnpm build` exit 0；Next.js 生产构建成功生成全部动态路由。
- 本地 `pnpm test:integration` 在缺少 `TEST_DATABASE_URL`、`TEST_DATABASE_NAME`、`TEST_DATABASE_MODE=isolated`、`TEST_RUN_ID` 时 exit 1，并明确报告保护拒绝；没有以 skip 冒充通过。
- 本机没有可用测试 PostgreSQL，因此真实数据库和浏览器证据以 CI run 为准。

## 回滚与未覆盖范围

没有执行生产写入、生产删除、`prisma migrate reset`、force push 或 auto-merge。回滚应由负责人审阅后回退 `codex/001-account-import` 的提交，并按审核后的逆向迁移/备份恢复处理数据库。

联系方式提取、导出、平台爬虫或真实 API、自动营销、审核工作台和跟进流程仍在 CODEX-001 范围外。

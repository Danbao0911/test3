# CODEX-002-T09 · 小红书与抖音接入验证

## 结论

本轮完成 T09 的官方能力核验和项目关闭态边界，未宣称平台真实接入完成。实现提交为 `7ad45a4af14e61d43d55551227b680c011f05444`，已推送到 [PR #2](https://github.com/Danbao0911/test3/pull/2)。

最终隔离 CI：[Push 35351375104](https://github.com/Danbao0911/test3/actions/runs/35351375104)、[PR 35351379545](https://github.com/Danbao0911/test3/actions/runs/35351379545)，均成功。

## 实现与验证

| 范围 | 修改 | 实际结果 |
| --- | --- | --- |
| 官方能力登记 | `docs/SOURCE_REGISTER.md` | 核验小红书 `basic_info` 主动授权资料、抖音 `user_info` + `access_token` + `open_id` 授权资料；记录官方链接、字段边界和未实现能力 |
| 能力矩阵 | `src/connectors/types.ts`、`src/connectors/registry.ts` | 新增 `accessPath`：小红书/抖音为 `AUTHORIZED_SUBJECT_ONLY`；仍为 `not_supported`、`verifiedAt=null`、请求预算 0 |
| UI 防误导 | `src/components/platforms-page.tsx` | 显示“仅主动授权主体资料”和“外部搜索未开放”，不显示已接入、关键词发现或第三人资料能力 |
| T09 单元验收 | `tests/unit/t09-platform-boundaries.test.ts`、`tests/unit/platform-adapters.test.ts` | 两个平台的 discover/fetch 返回 `not_supported`，无网络请求、无伪造数据；无项目应用、scope、主体范围和真实调用证据时不显示已验证 |

官方资料：

- [小红书授权范围](https://openaccount.xiaohongshu.com/docs/scope) 与 [API 参考](https://openaccount.xiaohongshu.com/docs/api-reference)：公开 `basic_info` 及用户授权流程。
- [抖音获取用户公开信息](https://partner.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/get-account-open-info)：公开接口要求 `user_info`、`access_token` 和 `open_id`。

这些官方文档只用于确认能力边界，不是本项目调用成功证据。本轮没有访问平台 API，没有接收或保存 app secret、access token、Cookie 或生产凭据。

## 保持关闭的范围

- 任意账号发现、关键词检索、第三人资料查询、商务联系方式提取、平台删除同步均未实现。
- 主体主动授权不自动扩大为批量发现、跨账号关联、长期保存、导出或外部模型处理权限。
- 小红书/抖音适配器不会返回空数组来伪装成功；当前返回 `not_supported`，项目来源仍需走获准人工导入和现有审核流程。
- T08 继续保持关闭态预检；真实联系人提取、批准、外联和生产部署不变。

## CI 与本地边界

最终 CI 实际执行：

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 退出码 0 |
| `pnpm db:generate` | 退出码 0 |
| `pnpm db:migrate` | 受保护隔离 PostgreSQL 成功 |
| `pnpm lint` | 成功 |
| `pnpm typecheck` | 成功 |
| `pnpm test:unit` | 9 files，129 passed，0 failed，0 skipped |
| `pnpm test:integration` | 7 files，67 passed，0 failed，0 skipped |
| `pnpm test:e2e` | 10 passed，0 failed，0 skipped |
| `pnpm build` | 成功 |

本地已运行并通过 `pnpm test:unit`、`pnpm typecheck`、`pnpm lint`、`pnpm exec next build --webpack` 和 `git diff --check`。本机没有受保护隔离 PostgreSQL，因此本地未运行迁移、集成和 E2E；这些命令由上述 CI 在临时数据库和独立 E2E 环境实际执行。

## 数据影响、未完成项与回滚

本轮无数据库迁移、无生产写入、无外部网络请求。新增的 `accessPath` 只是能力状态元数据，不授予任何平台权限。旧账号、联系人、证据、来源策略、导出和抑制数据不变。

T09 仍为“部分完成”：项目负责人尚未登记应用主体、scope、账号范围、字段用途、费用/配额、撤权和删除责任，也没有最小真实调用记录。因此不能进入真实 transport 或自动采集。回滚可恢复提交 `b31c0878ccced4b239dfa1b5d6acd80f59e5f3ad`，无需数据库降级；不执行 reset，不修改 `main`，PR 保持未合并。

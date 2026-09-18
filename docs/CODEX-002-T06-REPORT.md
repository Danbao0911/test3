# CODEX-002-T06 · 去重与跨账号关联审核

## 交付状态

本轮继续更新现有 [PR #2](https://github.com/Danbao0911/test3/pull/2) 的 `codex/002-contact-review`，只追加 T06，不修改 `main`、不强推、不自动合并、不部署生产。

- 最终 head：`62bd167636aa213cdedec2fb6c2ac662ea1034cb`
- 真实 PR：[Danbao0911/test3#2](https://github.com/Danbao0911/test3/pull/2)，状态 `OPEN`
- 成功 PR CI：[35318758595](https://github.com/Danbao0911/test3/actions/runs/35318758595)，同一 SHA 的 verify/e2e 均成功
- Push CI：[35318755068](https://github.com/Danbao0911/test3/actions/runs/35318755068)，verify 成功；e2e 首次和仅失败 job 重跑均失败在既有 T05 浏览器筛选用例，T06 新增浏览器用例通过。该 Push e2e 非绿色事实保留在报告中，不用 PR CI 的绿色结果掩盖。

本报告不把绿色 CI 表述为生产上线或四平台自动采集。

T06 目标是：同平台身份精确去重；不同账号不因同名、头像或共享联系自动合并；跨账号关联只能形成可审计的 PENDING 候选，并由 ADMIN/REVIEWER 明确确认或撤销；来源关联许可、撤销、到期和当前策略版本持续生效。

## 修改位置与行为

- `prisma/schema.prisma`、`prisma/migrations/20260918200000_account_links/migration.sql`：新增 `AccountLink`、`AccountLinkStatus`、`AccountLinkBasis`，保留左右账号、来源、策略版本、候选证据内部引用、版本、操作人和审核人；数据库约束要求账号不同且使用 UUID 字典序规范化的单一方向。`Source` 和 `SourcePolicySnapshot` 增加 `allowRelate`，默认为关闭，迁移只追加、不修改既有迁移、不清空数据。
- `src/lib/account-link-service.ts`：统一规范账号对、事务内咨询来源锁、来源状态/许可/快照/到期/类型校验、共享联系候选校验、版本冲突和最小化审计。共享联系只作为候选依据，不直接确认；撤销后不能静默恢复。当前策略不可用时 `usable=false`，历史候选不恢复旧权限。
- `src/app/api/account-links/route.ts`、`src/app/api/account-links/[id]/route.ts`、`src/app/api/account-links/suggest/route.ts`：真实 GET/POST/PATCH 接口；POST 只创建 PENDING，PATCH 要求 `expectedVersion` 和非空理由，VIEWER 可按最少字段读取但不能写入。
- `src/components/account-links-page.tsx`、`src/app/account-links/page.tsx`、`src/components/navigation.tsx`、`src/components/contacts-panel.tsx`：关联审核工作台和从已审核联系项生成候选的入口。页面不显示候选联系原值，也不自动合并账号。
- `src/app/api/sources/route.ts`、`src/app/api/sources/[id]/route.ts`、历史接口和来源页面：管理员明确开启/关闭 `allowRelate`，每次有效策略变更写不可变快照并带版本。
- `tests/unit/account-link.test.ts`：规范账号对、同账号拒绝、VIEWER 理由脱敏和当前来源失效断言。
- `tests/integration/account-link-review.integration.test.ts`：四个独立身份的真实 HTTP 测试；覆盖同名分离、精确重复、共享联系候选、确认版本冲突、撤销不可恢复、来源撤权、VIEWER 读写权限和审计边界。
- `tests/e2e/account-link-review.spec.ts`：真实浏览器创建两个同名独立账号、创建待审关联、填写理由确认并按状态查看当前可用性。

## 验收映射

| 任务书要求 | 实际断言 |
| --- | --- |
| 同平台精确去重 | 现有导入服务继续使用 `platform + nativeId`、`platform + normalizedProfileUrl` 唯一键和锁；T06 HTTP 测试重复主页返回 `DUPLICATE`，两个同名不同主页仍保持两个账号。 |
| 不因头像/昵称/共享联系自动合并 | 共享联系两个 APPROVED 联系项只创建 `SHARED_CONTACT_CANDIDATE/PENDING`；账号数量不变，响应不含联系原值和证据 ID。 |
| 来源无许可时阻止关联 | `allowRelate=false`、DRAFT/REVOKED/到期、版本快照缺失或 legacy 均在事务内拒绝；确认还会重新锁定当前来源。 |
| 人工确认/撤销和并发 | PATCH 带 `expectedVersion`；旧版本返回 `409 LINK_CONFLICT`，撤销后确认返回 `409 INVALID_TRANSITION`，变更写最小化 `ACCOUNT_LINK_*` 审计。 |
| 当前策略决定可用性 | `usable` 由当前 APPROVED、未到期、允许关联且策略版本一致共同决定；来源撤销/关闭后已确认记录不再可用。 |

## 本地验证边界

本地已通过：`pnpm db:generate`、`pnpm exec prisma validate`、`pnpm lint`、`pnpm typecheck`、`pnpm test:unit`（96 通过，0 失败，0 跳过）、`pnpm exec next build --webpack` 和 `git diff --check`。默认 Turbopack 构建在当前运行环境两次都因内部 worker 绑定端口权限失败；Webpack fallback 构建成功，CI 仍以项目默认 `pnpm build` 为准。

本地执行 `pnpm test:integration` 被测试数据库保护检查安全拒绝：未设置 `TEST_DATABASE_URL`、`TEST_DATABASE_NAME`、`TEST_RUN_ID`，因此没有访问任何数据库；本地未运行迁移或 E2E。CI 必须在隔离、非特权、run ID 绑定的 PostgreSQL/E2E 环境中执行完整流程。

## 迁移、旧数据与回滚

新迁移只增加来源关联能力列、可空的历史快照列和 `AccountLink` 表/索引/外键。既有来源的 `allowRelate` 默认关闭；迁移前的未知策略快照仍是 `legacy/unknown`，不会用最新许可反填，也不会恢复旧关联可用性。既有账号、证据、联系人、审核记录和 T05 工作台数据保留。

回滚采用停服后恢复已验证的迁移前备份并回退到匹配应用提交；不执行未经验证的 down migration，不对开发库/生产库运行 `reset` 或无条件删除。若只回退应用而保留新表，旧应用必须先确认不会读取新关系；生产真实联系人处理仍关闭。

## 未完成项

## CI 详细统计

成功 PR CI `35318758595` 的实际结果：

| 阶段 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| `pnpm install --frozen-lockfile` | 2 个 job | 0 | 0 |
| `pnpm db:generate` | 2 个 job | 0 | 0 |
| `pnpm test:unit` | 96 | 0 | 0 |
| `pnpm db:migrate` | 2 个隔离库 | 0 | 0 |
| `pnpm lint` | 1 | 0 | 0 |
| `pnpm typecheck` | 1 | 0 | 0 |
| `pnpm test:integration` | 45 | 0 | 0 |
| `pnpm test:e2e` | 7 | 0 | 0 |
| `pnpm build` | 1 | 0 | 0 |

其中新增 T06 为 2 个单元测试、3 个真实 HTTP 测试和 1 个浏览器测试；集成总数包含既有 90 行导入、来源/联系审核、T05 工作台及 legacy 迁移回归。没有使用 skip、continue-on-error 或自动重试旧策略请求。

Push CI `35318755068` 的 verify job 实际成功并包含同样的 96 单元、45 集成和 CI build。该 Push run 的 e2e 首次失败 1 项，失败用例是既有 `tests/e2e/account-import.spec.ts` 的 T05 收藏筛选断言；仅失败 job 重跑仍在同一断言失败，其他 6 个 E2E（含 T06）通过。独立 PR CI `35318758595` 对同一 SHA 的 7 个 E2E 全部通过，因此该差异记录为测试环境非确定性结果，不能记为 Push e2e 通过。

T07 的删除、拒绝联系抑制、到期物理清理和受控导出仍未实现；真实平台采集、真实联系人提取/批准和生产外联仍禁止。历史上已经丢失的关联证据不会伪造补回，人工复核仍需新证据。

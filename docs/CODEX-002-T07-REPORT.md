# CODEX-002-T07 · 受控导出、删除与审计交付报告

> 状态说明（T07-R1）：本报告记录的是 T07 初始实现，不能替代 [`CODEX-002-T07-R1-REPORT.md`](./CODEX-002-T07-R1-REPORT.md)。T07-R1 已追加字段级许可、不可变导出清单、终态下载、依赖清理、全局抑制、恢复重放和有界清理；在 T07-R1 的隔离 PostgreSQL/CI 验收完成前，不声称本报告中的初始绿色 CI 覆盖了 R01–R08。

## 交付状态

T07 已实现并追加到现有 [PR #2](https://github.com/Danbao0911/test3/pull/2) 的 `codex/002-contact-review` 分支。功能代码最终 SHA 为 `1437a594fedb72f1cbe63b96a6778d2ac3ef4bb4`；未修改 `main`、未强推、未自动合并、未部署生产，也没有开放真实联系人提取、批准或平台外联。

本轮功能提交链：`b0405d7`（导出/抑制/删除主体）、`086d972`（删除证据及外键安全）、`ae211dc`（隔离 T07 HTTP 夹具）、`1437a59`（到期清理验收）。

最终代码 Push CI：[35330985799](https://github.com/Danbao0911/test3/actions/runs/35330985799)；对应 PR CI：[35330990951](https://github.com/Danbao0911/test3/actions/runs/35330990951)。两个 CI 的 `verify` 与 `e2e` 均通过。

## 实现与验收映射

| T07 要求 | 修改位置 | 实际验收 |
| --- | --- | --- |
| 字段级受控导出 | `prisma/schema.prisma`、`prisma/migrations/20260918220000_t07_export_suppression_deletion/migration.sql`、`src/lib/validation.ts`、`src/lib/export-service.ts` | 仅允许白名单字段；来源必须 APPROVED、当前策略允许导出、策略快照非 legacy、联系人已人工核验且未过期；未审核、撤权、过期、抑制和 DO_NOT_CONTACT 均不能导出 |
| 下载链接与导出审计 | `src/app/api/exports/route.ts`、`src/app/api/exports/[id]/download/route.ts`、`src/lib/data-protection.ts` | 随机一次性 token 只存哈希，载荷 AES-GCM 加密，链接 1–30 分钟到期；下载后再次使用返回 410；`EXPORT_CREATED`/`EXPORT_DOWNLOADED` 只记录 actor/action/target |
| 策略二次校验 | `src/lib/export-service.ts`、来源 PATCH/历史 API 与页面 | 创建和下载均锁定来源并核对最新策略版本；下载前策略撤销/关闭导出即 410，不把旧授权换成新授权重试 |
| CSV 安全与最小字段 | `src/lib/data-protection.ts`、`src/components/exports-page.tsx` | 所有 CSV 单元格引用并处理公式前缀；默认不包含平台完整原文，联系字段必须经过当前来源策略及双确认 |
| 拒绝联系抑制 | `src/lib/retention-service.ts`、`src/app/api/contacts/[id]/suppression/route.ts`、`src/lib/contact-service.ts` | HMAC 指纹而非原值，默认 180 天上限；提取遇到有效抑制时不创建候选；审核员/管理员可执行，VIEWER 拒绝 |
| 删除与临时物清理 | `src/app/api/deletion-requests/route.ts`、`src/lib/retention-service.ts`、`src/lib/export-service.ts` | 账号删除清理账号、证据、联系项及受影响导出；联系项删除删除其证据并清理账号相关导出；保留最小删除记录和指纹，不复制原文 |
| 到期清理 | `src/app/api/retention/cleanup/route.ts`、`src/lib/export-service.ts` | 管理员接口在一个事务中清理到期联系、导出和抑制并写最小 `RETENTION_CLEANUP` 审计；VIEWER 无权触发 |
| 管理员页面 | `src/app/exports/page.tsx`、`src/components/exports-page.tsx`、`src/components/navigation.tsx` | 管理员可选择字段、筛选并生成一次性链接；其他角色不显示入口且 API 仍服务端拒绝 |

没有服务器缓存或外部索引层；删除事务覆盖当前数据库、Evidence/ContactPoint 和 ExportJob 临时载荷。`ContactSuppression` 使用 keyed fingerprint，删除/抑制规则以最小哈希和处理记录保留，便于在受控备份恢复流程中按规则重放，而不会把私人联系值写入黑名单或通用审计。

## 实际问题样例

- 未审核或来源关闭：导出接口返回 `NO_EXPORTABLE_ROWS`；已创建链接在来源 `allowExport=false` 后，下载前二次校验返回 `EXPORT_REVOKED`/HTTP 410。
- CSV 公式注入：账号名 `=T07 公式测试账号` 下载后以 `'=` 开头，不再作为表格公式执行。
- 一次性下载：同一链接第一次 HTTP 200，第二次 HTTP 410。
- 拒绝联系：有效抑制使重复提取返回 `createdCount=0, suppressedCount=1`，不新增 ContactPoint、Evidence 或候选审计；抑制表只有指纹、类型、依据、期限和操作人。
- 删除：删除联系项后 ContactPoint 和对应 Evidence 均不存在，账号相关导出临时物同步清除；删除账号后 Account 和对应 ExportJob 均不存在。
- 到期清理：真实 HTTP 将隔离库中的 ExportJob 与 ContactSuppression 标记过期，管理员清理返回各自清理数量并删除记录；VIEWER 返回 403。

## 测试与 CI 结果

最终 Push/PR CI 均为成功，失败和跳过均为 0：

| 阶段 | 通过 | 失败 | 跳过 | 说明 |
| --- | ---: | ---: | ---: | --- |
| `pnpm test:unit` | 102 | 0 | 0 | 7 个测试文件，含数据保护、CSV 公式、验证边界 |
| `pnpm test:integration` | 50 | 0 | 0 | 5 个文件；含 T07W01/W02/W03/W04/W05、迁移旧数据和既有 T01–T15/C01–C14 回归 |
| `pnpm test:e2e` | 8 | 0 | 0 | 含管理员导出、一次性下载、删除及既有账号/工作台/关联流程 |
| `pnpm lint` | 成功 | 0 | 0 | CI 与本地均成功 |
| `pnpm typecheck` | 成功 | 0 | 0 | CI 与本地均成功 |
| `pnpm build` | 成功 | 0 | 0 | CI 正式构建成功 |

中间失败已按日志修复，未作为最终验收依据：`35329941714` 暴露联系删除后证据残留和删除外键问题；`35330279632` 暴露固定邮箱跨 HTTP 用例污染。最终 `35330985799` 已重新执行全套隔离测试并通过。

## 本地与 CI 的明确边界

本地已运行并通过：`pnpm install --frozen-lockfile`、`pnpm db:generate`、`pnpm exec prisma validate`、`pnpm test:unit`（102/102）、`pnpm lint`、`pnpm typecheck`、`pnpm exec next build --webpack`、`git diff --check`。

本地未运行：`pnpm db:migrate`、`pnpm test:integration`、`pnpm test:e2e` 和项目脚本 `pnpm build`。本机没有经过保护检查的隔离 PostgreSQL；`pnpm test:integration` 在缺少 `TEST_DATABASE_URL`、`TEST_DATABASE_NAME`、`TEST_RUN_ID`、`APP_MODE=test` 时主动拒绝，因此没有访问或迁移开发库。CI 在两个绑定 run ID、非特权、隔离 PostgreSQL 数据库中实际执行迁移、HTTP 集成、E2E 和 `pnpm build`。

## 迁移、旧数据与回滚

新增且只追加 `20260918220000_t07_export_suppression_deletion`：为 Source/SourcePolicySnapshot 增加导出能力快照，新增 ContactSuppression、ExportJob、DeletionRequest 及索引/外键。旧来源策略的 `allowExport` 为未知/关闭，不用最新授权反填；历史账号、联系人、Evidence、审核记录保留。CI 已在空的隔离库按完整迁移链执行成功；没有修改已应用迁移、没有清空用户数据库、没有对开发/生产库执行迁移。

回滚使用迁移前已验证备份和匹配旧版本代码，不执行未经验证的 down migration、reset 或无条件删除。恢复备份后，必须连同最小删除/抑制规则备份按 fingerprint/targetHash 重放；本轮没有对真实备份做恢复演练，也没有声称具备生产数据恢复保证。

## 未解决项

T08/T09 的四平台真实接入、真实数据试点、生产联系人提取/批准、外部副本回收和备份恢复演练仍未开放；本轮没有服务器外联、平台爬虫、自动私信或生产部署。T07 的导出/删除/抑制功能只在隔离 demo/test 数据上验证，绿色 CI 不等于生产上线或四平台自动采集已完成。PR #2 保持打开，未自动合并。

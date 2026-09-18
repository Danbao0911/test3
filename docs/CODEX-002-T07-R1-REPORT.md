# CODEX-002-T07-R1 · 导出、删除、抑制及生命周期整改

## 状态

R2 复核已在 [CODEX-002-RECHECK-R2-REPORT.md](./CODEX-002-RECHECK-R2-REPORT.md) 追加修复生命周期规则、维护 CLI checkpoint、身份锁和登录租约。本 T07-R1 报告的“已完成”只适用于其原始基线；不能覆盖 R2 对恢复阻塞和跨进程并发的新增限制。

T07-R1 代码、真实测试和本报告均已追加到 PR [#2](https://github.com/Danbao0911/test3/pull/2) 的 `codex/002-contact-review`。功能/测试最终提交为 `7d78ca5b226da15dc054197b2c5fef11453c1109`；未修改 `main`、未强推、未自动合并、未部署生产。真实联系人提取和批准开关继续关闭。PR CI 已在隔离 PostgreSQL 和独立 E2E 数据库完成。

最终 Push CI：[35336417309](https://github.com/Danbao0911/test3/actions/runs/35336417309)；对应 PR CI：[35336420997](https://github.com/Danbao0911/test3/actions/runs/35336420997)。两个 CI 的 `verify` 与 `e2e` 均通过，具体计数见下表。此前 `35336089025` 的失败仅是新增测试响应类型未收窄，已由 `7d78ca5` 修复并重新全量验证。

## R01–R08 修改与测试映射

| 项目 | 实现位置 | 验收/测试映射 |
| --- | --- | --- |
| R01 不可变导出清单 | `prisma/schema.prisma`、`prisma/migrations/20260918230000_t07_r1_export_lifecycle/migration.sql`、`src/lib/export-service.ts` | `ExportJobManifest` 逐行保存账号、联系项版本、Evidence、字段来源和策略快照；下载逐行核验，不再按当前行数放行；新增 `tests/integration/t07-export-retention.integration.test.ts` 旧联系失效/新联系同数拒绝用例 |
| R02 下载终态/解密 | `src/lib/export-service.ts`、`src/app/api/exports/[id]/download/route.ts` | 过期/撤销先提交终态再返回 410；成功前先做清单、策略、摘要和 AES-GCM 校验；损坏密文不写下载成功审计；同 token 只有一个事务能成功 |
| R03 依赖删除/有界清理 | `src/lib/retention-dependencies.ts`、`src/lib/retention-service.ts`、`src/lib/export-service.ts`、`AccountLinkEvidence.referenceEvidenceMissing` | 联系到期/手动删除共用清理；删除 Evidence 前标记引用缺失并清理相关导出；清理按最多 100 条和游标分批；新增到期联系人与未到期导出联动的真实 HTTP 测试 |
| R04 全局抑制 | `src/lib/data-protection.ts`、`src/lib/contact-service.ts`、`src/lib/contact-policy.ts`、`src/lib/account-workspace.ts`、`src/lib/account-link-service.ts`、`src/lib/export-service.ts`、`src/lib/retention-service.ts` | 同类型同规范值跨账号/来源使用 HMAC 指纹和 `ContactPoint.suppressed`；提取、批准、工作台可用性、关联、导出均拦截；新增跨账号真实 HTTP 测试 |
| R05 来源字段许可 | `Source.allowedExportFields`、`SourcePolicySnapshot.allowedExportFields`、来源 API/历史、`src/lib/export-service.ts`、`src/components/sources-page.tsx` | 账号元数据字段和联系字段按实际来源分别与当前策略字段白名单求交；旧快照字段未知默认关闭；字段许可变化使旧清单失效 |
| R06 恢复重放/批次清理 | `src/lib/retention-service.ts`、`scripts/retention-maintenance.ts`、`package.json`、`docs/T07-RETENTION-RUNBOOK.md` | `pnpm retention:cleanup` / `pnpm retention:replay` 支持 dry-run、隔离库保护、退出码、批次游标和幂等重放；旧 UUID/`LEGACY_UNKNOWN` 不猜测新记录；当前尚未部署调度/告警 |
| R07 行数/请求体/指纹 | `src/lib/export-service.ts`、`src/lib/request.ts`、导出/删除/清理 API、`src/lib/data-protection.ts`、`tests/unit/t07-retention.test.ts` | 最终 CSV 数据行上限 500，另有限制 2 MiB；排除原因只记计数；JSON 流式累计字节超限 413；URL 指纹不无依据统一小写；CSV 引号/换行/公式防护保留 |
| R08 真实验收 | `tests/integration/t07-export-retention.integration.test.ts`、`tests/integration/policy-history-migration.integration.test.ts`、`tests/unit/t07-retention.test.ts` | 保留既有来源策略、角色、审核、关联、工作台和 90 行导入回归；新增 HTTP/数据库断言，不能由模拟替代 |

## 关键实际结果

- 导出清单不再允许 `old@example.com` 失效后用同账号新联系方式填补同样行数；清单中的 `contactId`、版本、Evidence 和策略快照必须仍然存在且一致。
- 修复前仅比较当前合格行数，旧导出可能被新联系方式填满；修复后旧联系失效并批准同账号 `new@example.com` 时，旧 token 返回 HTTP 410、数据库终态为 `REVOKED`，响应不含旧邮箱或新邮箱，载荷被清除。
- 修复前来源从 v1 变为 v2 时可能沿用数量；修复后即使 v2 仍允许导出，旧清单因策略快照不一致返回 HTTP 410，不自动替换授权。
- 来源 v1→v2 或字段白名单变化，即使 `allowExport=true`，旧任务也会在下载前返回 410 并持久化 `REVOKED`；旧任务没有清单时也会撤销并清空载荷，不用最新授权补齐。
- 过期、撤销、损坏密文和摘要不一致均不会留下 `DOWNLOADED` 或 `EXPORT_DOWNLOADED` 成功记录；下载成功后清空密文并轮换 token 哈希。同 token 并发下载由行锁保证最多一次成功。
- ContactPoint 到期时，相关 Evidence、审核原文和账号相关临时导出不会因 ExportJob 尚未到期而继续保留；`AccountLinkEvidence` 标记 `referenceEvidenceMissing=true`，不会把 SET NULL 当成独立证据。
- 同值抑制会更新全部账号/来源的同类型规范值联系人；旧 v1 HMAC 记录通过兼容候选继续生效，新 URL 只按类型规范化，不把路径、查询或 fragment 的大小写无依据合并。
- `SourcePolicySnapshot.allowedExportFields` 使用 nullable 文本 JSON 表示：新快照写入字段白名单，迁移前未知为 `NULL`，不会从 `allowExport=true` 推断全部字段。

## 迁移与旧数据

新增且只追加 `20260918230000_t07_r1_export_lifecycle`：增加 `ExportJobManifest`、来源字段许可、ContactPoint 抑制标记、AccountLinkEvidence 引用缺失标记、导出摘要/排除原因、指纹版本/key id/scope，以及删除规则的稳定身份指纹和期限。旧 `SourcePolicySnapshot` 字段许可为 unknown/legacy；旧 `ExportJob` 没有清单或摘要时下载会失败关闭，不补授权。旧抑制记录默认为 legacy v1 并通过旧 HMAC 候选兼容，不重新保存原始值。没有修改已应用迁移、没有 reset、没有清空用户数据库。

回滚采用停服务、保留当前数据库、使用已验证的整库备份和匹配旧代码前向恢复；不执行 down migration。恢复演练须仅在隔离副本执行，并按 `docs/T07-RETENTION-RUNBOOK.md` 重放带范围/版本/期限/key id 的规则。用户已经下载到外部的 CSV 不承诺可回收。

## 命令和测试状态

本轮已实际执行：

| 命令 | 结果 |
| --- | --- |
| `pnpm db:generate` | 通过，退出码 0 |
| `pnpm exec prisma validate` | 通过，退出码 0 |
| `pnpm test:unit` | 102 通过，0 失败，0 跳过 |
| `pnpm typecheck` | 通过，退出码 0 |
| `pnpm lint` | 通过，退出码 0 |
| `git diff --check` | 通过，退出码 0 |
| `pnpm test:integration` | 本机未执行数据库测试：缺少 `TEST_DATABASE_URL`、`TEST_DATABASE_NAME`、`TEST_RUN_ID`，保护检查拒绝且未访问数据库；CI 实际 55/55 通过 |
| `pnpm test:e2e` | 本机未执行：无隔离 E2E 环境；CI 实际 8/8 通过 |
| `pnpm build` | 本机默认 Turbopack 因沙箱内部进程绑定限制失败；`pnpm exec next build --webpack` 通过；CI 项目脚本实际通过 |

最终 PR CI 的实际结果：unit 102 通过、integration 55 通过、E2E 8 通过；失败 0、跳过 0。`lint`、`typecheck`、`build` 均退出码 0。CI 使用带 `TEST_RUN_ID=35336420997` 的隔离数据库，迁移链和真实 HTTP 接口均执行成功。

本机尚未在经过保护检查的隔离 PostgreSQL 上运行 `pnpm db:migrate`；CI 已在临时隔离库执行迁移。`pnpm exec next build --webpack` 是本地替代构建验证，项目默认 `pnpm build` 的正式结果以 CI 为准。

## 未完成项

仍未完成或不应宣称完成的事项：R06 的真实备份副本恢复演练、两批清理中断后的运行级恢复，以及生产环境调度/告警尚未部署；用户已经下载到外部的 CSV 不可回收。CI 已覆盖本轮新增的真实 HTTP、数据库、迁移、501 行/413、指纹兼容和 E2E 回归，但不等于生产上线，也不等于四平台自动采集。若需回滚，停服务并使用已验证的旧代码和整库备份前向恢复，不执行 down migration、reset 或无条件删除。

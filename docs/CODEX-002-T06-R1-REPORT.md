# CODEX-002-T06-R1 · 账号关联证据、有效性与撤销整改

## 交付边界

本报告继续更新 [PR #2](https://github.com/Danbao0911/test3/pull/2) 的 `codex/002-contact-review`，只整改 T06-R1；不修改 `main`、不强推、不自动合并、不部署生产，不开启真实联系人提取、真实平台调用或生产外联。

R1 将 T06 初版的“理由即可确认”改为“关系专用证据 + 人工审核决定”才能确认。共享联系方式仍然只能产生待审候选，不能单独证明两个账号属于同一主体。

## R1—R8 修改与测试映射

| 要求 | 实现位置 | 验收覆盖 |
| --- | --- | --- |
| R1 关系证据与权限映射 | `prisma/schema.prisma`、`src/lib/account-link-service.ts`、`src/lib/validation.ts` | 确认必须有来源地址/证据引用、取得时间、定位、最小说明、两侧账号核验；无证据、共享联系方式单独确认、无关来源均拒绝 |
| R2 当前有效性 | `src/lib/account-link-service.ts`、账号关联列表/详情 API | `evaluateAccountLink` 统一检查来源状态、用途、到期、当前快照、关系证据和共享联系依赖，返回 `unusableReason`；旧策略、失效联系、缺失引用不可确认/不可用 |
| R3 加锁与并发 | `src/lib/account-link-service.ts` | 来源 ID 排序锁 → 账号对稳定锁 → 联系项/关联行锁；建议批次先确定并排序账号对；可重试事务冲突最多 3 次，不重试权限/版本/证据错误 |
| R4 审核历史 | `AccountLinkEvidence`、`AccountLinkDecision` 及 `20260918210000_account_link_evidence_history` | 确认/撤销保存轮次、前后状态、版本、操作人、理由和证据指针；旧记录无证据标记不可用，不伪造历史证据 |
| R5 网页撤销与证据核对 | `src/components/account-links-page.tsx`、`/api/account-links/[id]/history`、E2E | PENDING 展示证据输入；CONFIRMED 展示撤销按钮；撤销要求理由和当前版本；页面显示允许查看的证据、策略版本和审核历史 |
| R6 分页与有界建议 | `listAccountLinks`、`suggestAccountLinksForContact`、关联 API/页面 | 列表返回 `total/hasMore/page/pageSize`；建议每批最多 50 条并返回 `nextCursor`，排序稳定，不静默截断 |
| R7 请求体/参数边界 | `src/lib/account-link-http.ts`、`src/lib/validation.ts` | JSON 累计 16 KiB 限制（无 Content-Length 也生效）；超限 413、坏 JSON 400、字段错误 422；未知字段和大小写 UUID 均不进入数据库错误路径 |
| R8 真实回归 | `tests/unit/account-link.test.ts`、`tests/integration/account-link-review.integration.test.ts`、`tests/e2e/account-link-review.spec.ts`、迁移测试 | 保留同名分离、精确去重、联系审核、来源策略、VIEWER、90 行导入和工作台回归；增加证据缺失、旧策略、来源撤销后仍 CONFIRMED、并发确认、网页撤销/历史和请求边界 |

## 关键行为

- 创建和建议始终只生成 `PENDING`；`reason` 不能替代关系证据。
- 确认事务会重新锁定当前来源和账号对，检查关系证据覆盖两侧账号的来源许可；不同来源可以使用，但每个来源都必须有当前策略和账号覆盖映射。
- `AccountLink` 的候选策略版本、关系证据策略版本、共享联系项证据版本和当前来源策略必须一致；来源撤销、关闭 `allowRelate`、到期或重新开启后的新版本都会使旧关系 `usable=false`，不会复活旧记录。
- 已确认关系撤销后只能保留 `REVOKED` 历史；本轮不提供静默复核恢复入口，重新核验必须建立新的证据/审核轮次，当前唯一关系约束不会被绕过。
- VIEWER 只可看到两侧账号、状态、非敏感状态码和脱敏历史，不返回理由、来源地址、证据定位、摘要或证据引用。
- 审计仍只保存 actor/action/target/time，不复制联系原值、关系证据正文或审核理由。

## 迁移与旧数据

新增 `20260918210000_account_link_evidence_history`，只创建 `AccountLinkEvidence`、`AccountLinkDecision` 表及索引/外键，不修改已应用迁移、不清空数据。既有 T06 关系没有凭空补造证据；缺少关系证据的已确认记录会被统一判定为 `LINK_EVIDENCE_MISSING`，历史状态仍保留。旧来源策略的未知历史继续按 `legacy/unknown` 处理，不能用当前许可反填。

回滚使用已验证的迁移前备份和匹配应用版本，不执行未经验证的 down migration、`reset` 或无条件删除。

## 验证记录

本地已通过：`pnpm db:generate`、`pnpm exec prisma validate`、`pnpm lint`、`pnpm typecheck`、`pnpm test:unit`（99 通过，0 失败，0 跳过）、`pnpm exec next build --webpack`、`git diff --check`。

本地 `pnpm test:integration` 按项目保护规则拒绝执行，因为当前 shell 没有 `TEST_DATABASE_URL`、`TEST_DATABASE_NAME`、`TEST_RUN_ID` 和 `APP_MODE=test`；没有访问或迁移任何数据库。本地 E2E 未运行，待 CI 隔离环境验证。

CI run、完整提交 SHA、通过/失败/跳过统计将在本轮代码推送后的真实 GitHub Actions 完成后追加；不以本地静态检查替代 PostgreSQL 和浏览器验收。

## 未解决项

T07 的删除、拒绝联系抑制、到期物理清理、受控导出、真实平台采集和生产外联仍未实现；本报告不宣称生产可用或四平台自动采集。关系历史上已经丢失的证据不会伪造补回，人工复核仍需新证据。

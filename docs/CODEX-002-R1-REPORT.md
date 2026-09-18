# CODEX-002-R1 第二部分审查整改报告

## 交付状态

本轮已完成 R01—R05 的代码、HTTP、单元、浏览器和增量迁移验收，并继续更新现有 [PR #2](https://github.com/Danbao0911/test3/pull/2)。

- 仓库：`Danbao0911/test3`
- 分支：`codex/002-contact-review`
- 基线：审查基线 `2b2ccf5ff19e7c1499050a098daa7bbe232eb886`；PR 基线 `b8a810fb2e75c170fcdd1fd545e888a4cc47c0e0`
- 最终提交：`a7f1396e965e6510f4f3bdb06e3ff31d86a09c14`
- 最终 CI（push）：[35297926463](https://github.com/Danbao0911/test3/actions/runs/35297926463)
- 同 SHA 的 PR CI：[35297929392](https://github.com/Danbao0911/test3/actions/runs/35297929392)
- 最终两个 CI 均为 `verify=success`、`e2e=success`，未跳过、未自动重试。

本报告只说明隔离测试环境中的实现和验证，不表示生产上线、真实联系人开放或四平台自动采集已经完成。

## R01：来源策略版本冲突

修改位置：

- `src/lib/validation.ts`：来源 PATCH 必须携带 `expectedPolicyVersion`。
- `src/app/api/sources/[id]/route.ts`：来源行锁内核对版本；旧版本返回 `409` 和 `SOURCE_POLICY_CONFLICT`，不更新来源、不升版本、不写成功审计。策略内容未变化时直接返回当前值，不生成新版本。
- `src/app/api/sources/route.ts`、`src/components/sources-page.tsx`：创建、批准、编辑、撤销和前端保存都携带读到的版本。
- `src/components/sources-page.tsx`：409 时保留编辑草稿，显示“刷新后重新确认”，不自动以最新版本重试。

实际结果：

| 场景 | 修复前 | 修复后 | 覆盖 |
| --- | --- | --- | --- |
| A/B 旧表单覆盖 | A 可带旧的 `allowExtract=true` 覆盖 B 的关闭 | A 返回 `409 SOURCE_POLICY_CONFLICT`，提取权限仍关闭 | 集成 R01、E2E 双上下文 |
| 同版本并发 | 没有稳定的能力版本拒绝 | 一个 `200`、一个 `409`，最终只升一个版本 | 集成 R01 并发测试 |
| 相同内容保存 | 可能无意升版 | 版本、审计和已审核联系人可用性不变 | 集成 R01 无变化保存 |

## R02：失效、拒绝联系和第三方语境

修改位置：`src/lib/contact-extractor.ts`、`src/lib/contact-service.ts`。

提取器先分离标签、值 token、外围语境、尾随说明，再进行字段格式和演示地址校验。`friend@example.com`、`invalid@example.com` 仍按正常值测试；不会用全文出现 `friend`/`invalid` 的粗略规则拒绝。第三方、失效、`do not contact`、归属不明等语境会在候选写入前终止处理，且不会把被排除的完整输入写入审计或日志。

三个独立样例的实际结果：

- A `官网联系页：https://example.com/contact（已失效）`：修复前可产生 1 候选；修复后 0 候选。
- B `商务预约：https://example.com/book (do not contact)`：修复前可产生 1 候选；修复后 0 候选。
- C `商务联系页：这是第三方资料\n企业电话：+1 202 555 0100`：修复前可能只保存电话行；修复后 0 候选，第三方说明不会丢失后继续落库。

真实 HTTP 验收确认三个请求均返回空 `ids`/`createdCount=0`，`ContactPoint`、`Evidence` 和 `CONTACT_CANDIDATE_CREATED` 数量不变。测试位置：`tests/unit/contact-extractor.test.ts`、`tests/integration/account-import.integration.test.ts` 的 R02 场景。

## R03：完整 URL 和证据定位

修改位置：`src/lib/contact-extractor.ts`、`src/lib/account-normalizer.ts`、`src/lib/contact-service.ts`。

- 账号主页身份规范化继续使用原有身份键规则。
- 商务联系目标使用独立的 `normalizeContactTargetUrl`，保留 path、query、fragment；不在 URL token 内按分号盲切。
- 证据来源地址使用独立的 `normalizeSourceUrl`，保留 fragment；去重键和打开证据的 URL 分开保存。
- 未支持的同行多字段格式不静默截断；仍保持 HTTPS、域名、凭据、IP、端口和无外联限制。

实际结果：

- `https://example.com/book;service=trust`：修复前截成 `/book`；修复后 `rawValue` 和规范值均保留完整链接。
- `https://example.com/#/consultation` 与 `https://example.com/#/board`：修复前可能合并为同一个根地址；修复后产生两个候选，完整链接重复出现时精确去重。
- `https://example.com/about#business-contact`：修复前 fragment 丢失；修复后从 HTTP 入库、数据库 Evidence 到详情 API 均保留 fragment。

测试位置：`tests/unit/account-normalizer.test.ts`、`tests/unit/contact-extractor.test.ts`、`tests/integration/account-import.integration.test.ts` 的 R03 场景。没有服务器外联。

## R04：来源策略历史快照

修改位置：

- `prisma/schema.prisma`：新增 `SourcePolicySnapshot`，以 `sourceId + version` 唯一；Evidence 必须指向真实快照。
- `prisma/migrations/20260918150000_policy_snapshots/migration.sql`：追加迁移，不修改已应用迁移。已有未知 Source/Evidence 版本被标记为 `legacy/unknown`，不使用最新授权倒填。
- `src/app/api/sources/route.ts`、`src/app/api/sources/[id]/route.ts`：策略快照、策略切换审计和来源修改在同一事务中提交。
- `src/app/api/sources/[id]/history/route.ts`、`src/app/sources/[id]/history/page.tsx`：管理员/审核员可查询完整历史；只读成员只返回版本、状态、时间、变更类型和 legacy 标记等最小字段。
- `tests/integration/policy-history-migration.integration.test.ts`：在隔离临时 schema 中执行旧迁移、插入旧 Source/Evidence，再执行新迁移，确认旧版本均为未知快照且 Evidence 外键正确。

当前策略仍决定现在是否可用；legacy 快照不能绕过撤权、到期或当前策略版本校验。历史快照不复制联系人原文。

## R05：测试和交付统计

最终 CI [35297926463](https://github.com/Danbao0911/test3/actions/runs/35297926463) 的真实结果：

| 阶段 | 通过 | 失败 | 跳过 | 备注 |
| --- | ---: | ---: | ---: | --- |
| `pnpm install --frozen-lockfile` | 1 | 0 | 0 | lockfile 一致 |
| `pnpm db:generate` | 1 | 0 | 0 | 生成成功 |
| `pnpm test:unit` | 92 | 0 | 0 | 4 个测试文件 |
| `pnpm db:migrate` | 1 | 0 | 0 | 空库追加迁移成功 |
| `pnpm lint` / `pnpm typecheck` | 2 | 0 | 0 | 均成功 |
| `pnpm test:integration` | 35 | 0 | 0 | 含 R01/R02/R03/R04、T01—T15、C01—C14；含旧数据增量迁移测试 |
| `pnpm build` | 1 | 0 | 0 | CI 构建成功 |
| `pnpm test:e2e` | 3 | 0 | 0 | 含两个浏览器上下文策略冲突场景 |

本地实际运行：`pnpm db:generate`、`pnpm test:unit`（92/92）、`pnpm lint`、`pnpm typecheck`，均通过。由于本机没有可用 Docker/PostgreSQL，本地未运行 `pnpm db:migrate`、`pnpm test:integration`、`pnpm test:e2e`、`pnpm build`；这些项目由上述隔离 CI 实际运行并通过。

整改过程中曾有失败 CI：迁移旧数据分支的 PostgreSQL 类型转换、旧断言数量、未登录第二上下文和 Playwright alert 严格定位，分别在 `9362cf0`、`8048e58`、`2020b5f`、`1a537b4` 后修复。它们不是最终交付依据；最终 SHA 的两条 CI 均成功。

## 未解决项和边界

- 未开放生产真实联系人；生产环境仍禁止真实联系提取和批准。
- 未开始新的平台采集，不做外部网页、平台或联系人验证。
- T07 的物理删除、抑制、到期清理及受控导出仍是后续工作，因此不能宣称生产数据生命周期已经完整交付。
- 未自动合并 PR、未修改 `main`、未部署生产。

# CODEX-002-RECHECK-R3 · T10 与生命周期边界整改

## 结论

本轮 R01–R04 已实现并推送到 [PR #2](https://github.com/Danbao0911/test3/pull/2)，当前分支 `codex/002-contact-review`，最终实现提交为 `ca1e2a8e17e8835dc07ea969f2e70d20b563d395`。PR 保持 OPEN；没有修改 `main`、强推、自动合并、生产部署、真实平台请求、生产联系人提取或批准。

最终 Push CI：[35366235442](https://github.com/Danbao0911/test3/actions/runs/35366235442)；对应 PR CI：[35366240525](https://github.com/Danbao0911/test3/actions/runs/35366240525)。本轮第一次实现的 CI [35365904332](https://github.com/Danbao0911/test3/actions/runs/35365904332) 暴露了两个新增夹具问题，已在 `ca1e2a8` 修复；没有删除断言或使用 skip 掩盖失败。

## 修改与测试映射

| 项目 | 实现位置 | 真实验证 |
| --- | --- | --- |
| R01 checkpoint 模式安全 | `src/lib/maintenance-checkpoint.ts`、`scripts/retention-maintenance.ts`、`src/lib/retention-service.ts` | `tests/integration/recheck-r2-maintenance.integration.test.ts` 通过真实 CLI 子进程验证 dry-run continuation 交给 execute 返回模式冲突、没有删除；全新 execute 从头完成；原 cleanup 跨进程续跑继续通过。`tests/unit/t07-retention.test.ts` 覆盖 v2、模式、目标指纹、签名和游标。 |
| R02 历史 HMAC key 在线一致性 | `src/lib/data-protection.ts`、`src/lib/identity-rules.ts`、`src/lib/import-service.ts`；在线 contact/export/link/retention 调用继续复用 `suppressionFingerprintCandidates` | `tests/integration/latest-review.integration.test.ts` 在真实 PostgreSQL 配置 `old-v2` 与当前 v2 key：旧 key 身份删除规则阻止单条录入，旧 key 联系抑制阻止重新提取；205+205 恢复扫描、旧 v1、未知 key/算法阻塞继续通过。 |
| R03 非空规则恢复 | `scripts/t10-recovery-drill.ts`、`docs/T10-RUNBOOK.md` | 独立 CI job 使用真实 PostgreSQL、`pg_dump`/`pg_restore`、真实 `deleteTarget` 与 `replayDeletionRules`。备份前已有有效基线规则，备份后新增两组规则并更新一组；恢复后导入 JSON rule package 两次，校验依赖、稳定 UUID 合并和幂等；batch size 1 循环完成多目标，独立无关哨兵保留，第二轮完整重放零变化。 |
| R04 清理结果不吞错 | `src/lib/recovery-cleanup.ts`、`scripts/t10-recovery-drill.ts` | 单元测试对 fixture、disconnect、DROP、files 四类合成故障分别断言整体 `failed`、退出码 1；真实 T10 成功路径只有恢复验证和全部清理完成后才输出 `passed`。 |

## R01：checkpoint 实际行为

checkpoint 从 v1 升为 v2，签名内容增加 `mode`、非敏感 `targetFingerprint`，并继续绑定 operation、数据库名、run ID、截止时间和合法游标。目标指纹只由协议、主机、端口、数据库名和隔离运行标识组成的 hash 生成，不写入密码或完整连接 URL。旧 token 没有可证明的模式/版本时拒绝；篡改、错操作、错目标、错运行标识和 dry-run/execute 跨模式均在连接数据库写入前拒绝。

replay dry-run 的 `enforcementComplete` 返回 `null`，只输出 `previewComplete`/`scanComplete`；execute 才计算 `enforcementComplete`/`executionComplete`。正式执行不会消费 dry-run 游标。真实测试还保留了两个独立 Node 子进程的 cleanup checkpoint 续跑。

## R02：历史 key 与算法边界

`SUPPRESSION_HMAC_KEYS_JSON` 的 key id 映射现在用于所有在线候选指纹，新增规则仍只用当前写入 key。非 `legacy-v1` 的映射按 v2 计算，只有明确的 `legacy-v1` key 才按 v1 计算；URL、路径、查询、fragment 和 opaque identity 不因兼容而统一小写。身份删除规则读取会按规则自己的 key id 计算 native ID 与规范主页两个独立指纹；缺失 key、未知算法、未知 scope 或不完整身份不会被当成“无规则”，单条录入会明确阻断，恢复会进入 blocked 结果。

本轮没有持久化原始联系方式，也没有把当前 key 冒充历史 key。既有 CSV 路径调用相同的 `createAccountWithRules` 规则服务；重新提取、审核、关联和导出继续通过统一的历史抑制候选集合判断。

## R03：恢复包和数据库断言

恢复演练协议为 v1：完整 base dump 只恢复备份时点数据；备份后规则不再对整张 `ContactSuppression`/`DeletionRequest` 表重复 `pg_restore`，而是以 `backupCutoff`、`capturedAt`、稳定规则 UUID、所需操作人 UUID 和规则字段组成受控 package。目标库先核验操作人等外键依赖，缺失时返回 `RULE_DEPENDENCY_MISSING`，不伪造用户或导入密码。重复导入同一规则包使用相同 UUID 更新同一条规则，不插入重复记录，不清空规则表。

CI 演练包含：

- 备份前 1 条有效账号删除规则和 1 条有效联系人抑制规则；
- 备份后 2 个待删除目标的真实删除规则，其中 1 条抑制规则发生更新；
- 恢复后规则计数从基线 1/1 合并为 3/3；
- 账号和联系人以 `batchSize=1` 分别推进游标，直到扫描与执行完成；3 个受规则目标删除，无关 sentinel 保留；
- 第二轮从头完整扫描，删除账号/联系项均为 0，保持幂等；
- 目标库、fixture、连接和 dump 的清理均完成后才返回成功。

这是隔离恢复演练，不是云备份、异地容灾或生产恢复调度。当前没有部署生产恢复调度。

## R04：失败处理与资源归属

恢复验证和清理验证分开记录。只有 `recoveryVerified=true` 且 fixture 清理、连接断开、目标库 DROP、文件移除全部成功，结果才是 `status=passed`、退出码 0。主故障保留在 `primaryError`，清理错误只输出安全的步骤码和本轮运行标识。目标库只有在本次 `CREATE DATABASE` 成功后才允许 DROP；创建失败时不 DROP 同名既有库；不强制断开未知连接。

## 实际命令与结果

最终 Push/PR CI `35366235442`：

| 命令 / Job | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 退出码 0 |
| `pnpm db:generate` | 退出码 0 |
| `pnpm db:migrate` | 受保护隔离 PostgreSQL 成功，退出码 0；本轮无新增迁移 |
| `pnpm lint` | 退出码 0 |
| `pnpm typecheck` | 退出码 0 |
| `pnpm test:unit` | 10 files，141 passed，0 failed，0 skipped |
| `pnpm test:integration` | 8 files，70 passed，0 failed，0 skipped |
| `pnpm test:e2e` | 10 passed，0 failed，0 skipped，重试 0；合成 artifact 已上传 |
| `pnpm build` | CI Turbopack 构建成功，退出码 0 |
| `T10_RECOVERY_CONFIRM=1 pnpm t10:recovery:drill -- --execute` | 独立 T10 job 成功，退出码 0 |

第一次推送 `013aab6` 的 CI 失败只涉及本轮新测试夹具：历史 key 测试使用了不符合 synthetic 约束的主页，checkpoint 测试只有一个账号导致首批已扫描完成。`ca1e2a8` 改为合法 `/demo/` 路径并添加不受规则影响的第二个哨兵；修复后最终 CI 70 个集成测试全部通过。失败 run 不被记为通过证据。

## 本地与 CI 边界

本地本轮已实际运行并通过：`pnpm typecheck`、`pnpm test:unit`（141）、`pnpm lint`、`pnpm exec next build --webpack`、`git diff --check`。本机没有受保护的 `TEST_DATABASE_URL`/`TEST_DATABASE_NAME`/`TEST_RUN_ID`，因此本地没有运行 `pnpm db:migrate`、`pnpm test:integration`、`pnpm test:e2e`、T10 `--execute`；没有连接或清空开发库/生产库。隔离数据库迁移、真实 PostgreSQL、CLI 子进程、浏览器和 recovery drill 的证据来自上述 CI，不以本地单元测试替代。

## 迁移、回滚与未完成项

本轮没有 Prisma schema 变化和新增迁移，没有修改已应用迁移、没有 reset 或清空用户数据库。回滚使用上一份已验证提交的前向修复或匹配应用版本；不执行 down migration，不回滚已写入的生命周期规则。若恢复演练失败，依据输出的运行标识只清理本轮已创建资源，必要时人工处理明确列出的步骤；不能 DROP 未被本轮成功创建的同名数据库。

仍未完成：生产恢复调度、生产备份存储、告警通道、代理层 token 脱敏部署、真实数据试点、平台凭据和四平台外联。T08/T09 继续关闭态预检，真实联系人提取和批准仍关闭。用户已经下载到外部的 CSV 不承诺可由服务端回收。

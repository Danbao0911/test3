# CODEX-002-RECHECK-R2 · 生命周期一致性、恢复重放与登录并发复验

## 状态

本轮 R01–R05 已实施并推送到 PR [#2](https://github.com/Danbao0911/test3/pull/2)，但按复核意见仍标记为“部分完成”，不宣称生产验收或真实联系人处理已开放。最终代码 HEAD 为 `9c875c883f6e7560279d968d0de24ea818aae7a7`。

实现提交：

- `8b4a58c801a5c202495c8ec7dfb624c239860fc3`：R01–R05 主要实现、追加迁移和真实维护 CLI 子进程测试。
- `9c875c883f6e7560279d968d0de24ea818aae7a7`：收紧身份类型、旧 key 分类和 checkpoint 游标校验。

最终 PR CI：[35356773077](https://github.com/Danbao0911/test3/actions/runs/35356773077)；对应 Push CI：[35356768228](https://github.com/Danbao0911/test3/actions/runs/35356768228)。PR 保持 OPEN，分支为 `codex/002-contact-review`，未修改 `main`、未强推、未合并、未部署。

## R01：恢复规则分类、旧 key 与阻塞结果

修改位置：

- `src/lib/retention-service.ts` 的 `replayDeletionRules`、`replayRuleSupported`、`replaySuppressionSupported`。
- `src/lib/data-protection.ts` 的按 key id 取 HMAC、旧 key 映射和指纹候选。
- `src/lib/identity-rules.ts` 的按规则 key id 匹配。

根因是恢复查询先限定当前 `identityVersion`，导致未知活跃规则根本不进入阻塞统计；旧 v1 指纹也错误地使用当前 key 计算。本轮先加载活跃的账号重录规则和抑制规则，再按 scope、targetType、identityType、算法版本、key id、期限和必要指纹字段分类。缺 key、未知版本、未知 scope、空身份字段和不完整规则都进入 `blockedRules`，不会被当作无规则。

`SUPPRESSION_HMAC_KEYS_JSON` 支持受控的 key id→密钥映射。legacy-v1 只有在真实旧 key 可用时才匹配；当前 key 不再冒充旧 key。诊断只输出数量、内部 ID 和状态，不输出联系人原值或密钥。

测试映射：

- `tests/integration/latest-review.integration.test.ts`：真实 PostgreSQL 205+205 跨批扫描、索引 100/204 命中、未知账号删除规则、缺失 key 抑制、两把不同合成 key 的 legacy-v1 匹配、重复重放。
- `tests/unit/t07-retention.test.ts`：不同 key 的 legacy 指纹、缺 key 阻塞、URL/身份指纹边界。

## R02：维护 CLI、退出码与 checkpoint

修改位置：

- `scripts/retention-maintenance.ts`：按最后一次结果决定完成状态，加入严格参数校验、`--checkpoint`、`try/finally` 资源关闭和退出码。
- `src/lib/maintenance-checkpoint.ts`：绑定 operation、数据库名、运行 ID、截止时间的 HMAC checkpoint；校验签名、目标和允许的 UUID 游标。
- `src/lib/export-service.ts` 的 `runRetentionCleanup`：空库、单批和 dry-run 返回真实 `complete`，不再使用上一批旧游标判断。
- `docs/T07-RETENTION-RUNBOOK.md`：补充续跑和 key 配置说明。

约定：正常完成和只读 dry-run 退出码 0；达到批次上限且仍有游标退出码 2；扫描结束但 `blockedRules`/`legacyUnknown` 未清除时 `enforcementComplete=false`，退出码 3。checkpoint 不能跨操作、数据库或运行 ID 消费，且不能手工扩大游标范围。

测试映射：

- `tests/integration/recheck-r2-maintenance.integration.test.ts` 的 `consumes its own cleanup checkpoint in a new process`：创建真实过期规则，第一进程批次上限返回 2 和 continuation，第二个独立进程消费 continuation 并返回 0。
- 同文件的 `rejects a damaged checkpoint with a non-zero exit`：损坏 checkpoint 返回非零并拒绝执行。
- `tests/unit/t07-retention.test.ts`：错操作、篡改签名、未知游标和 checkpoint 目标校验。

## R03：删除与重导入身份锁

修改位置：

- `src/lib/identity-rules.ts` 新增 `accountIdentityLockKeys`，对平台+nativeId、平台+规范主页分别生成共享 hash advisory lock 键。
- `src/lib/import-service.ts` 的单条录入和批量导入改用该共享键。
- `src/lib/retention-service.ts` 的 `deleteTarget` 和恢复账号删除在同一 source→identity→fingerprint→account 顺序中加锁，并在锁后重新读取。
- `src/lib/resource-locks.ts` 保留稳定排序的数据库 advisory/行锁实现。

这样删除规则写入、旧实体删除、重导入资格判断和新实体写入在同一身份锁协议下串行；不再只按账号 UUID 或进程内互斥判断。nativeId 缺失时仍使用主页锁，不按昵称、头像或跨平台同名扩大范围。

测试映射：

- `tests/unit/t07-retention.test.ts`：验证导入与删除对相同身份生成完全相同的锁键，且锁键不包含原始 ID/URL。
- 既有 `tests/integration/account-import.integration.test.ts` 的单条、90 行 CSV、漏填 ID、同 ID 不同主页和正常幂等回归继续执行。
- 既有 T07 生命周期同步屏障集成测试继续覆盖导出/删除/提取/抑制入口，最终 CI 未出现 5xx 或不受控死锁。本轮未把测试替身当作 PostgreSQL 屏障证据。

## R04：全局抑制的锁后重读

修改位置：

- `src/lib/retention-service.ts` 的 `suppressAllCopies`：初始查询只发现 ID，行锁完成后重新查询当前 status、suppressed 和 version；`INVALID` 但未 suppressed 的副本也会新增明确版本历史。
- `src/lib/contact-service.ts` 的 `reviewContact`：所有状态转换，不只是 APPROVED，都先取得同值指纹锁，再锁 ContactPoint 并重读。
- 账号/联系人直接删除和恢复重放继续复用 `suppressAllCopies`，覆盖跨账号、跨来源同值副本。

这保留了原人工审核决定，不用旧 version 写重复历史，不捕获 P2002 后继续使用失败事务；同值新增联系人必须先经过同一指纹锁，不会在抑制后绕过全局规则。

测试映射：

- 既有 `tests/integration/t07-export-retention.integration.test.ts` 的同步屏障竞态、跨账号/来源抑制、删除和重新提取回归。
- 既有联系人审核并发、来源撤销/到期和全局抑制 HTTP 集成回归。
- 最终 CI 集成套件 69/69 通过；本轮没有删除既有断言或用 skip 代替并发验证。

## R05：登录预留归属与窗口代次

修改位置：

- `src/app/api/auth/login/route.ts` 的 `reserveLoginAttempt`、`completeLoginAttempt`、`POST`。
- `prisma/schema.prisma` 新增 `LoginThrottleReservation`。
- 追加迁移 `prisma/migrations/20260919020000_recheck_r2_login_leases/migration.sql`。

预留现在返回内部 reservation id、账号 hash、窗口起点和到期时间。只有持有该 reservation 的请求能幂等释放自己的 `inFlightCount`；旧窗口完成不会修改新窗口，reserve 失败的请求不会释放其他请求。到期租约在下一次准入时回收，保留成功登录不计失败、失败累计、窗口恢复、Origin、session 和请求体上限。

测试映射：

- `tests/integration/account-import.integration.test.ts` 的真实 HTTP “9 次失败+12 并发”回归：1 次 401、11 次 429，最终 `attemptCount=10`、`inFlightCount=0`，窗口到期后成功登录恢复。
- 新迁移在 CI 隔离 PostgreSQL 中实际应用；维护和登录代码在真实数据库客户端上执行。

## 迁移与旧数据影响

只新增 `20260919020000_recheck_r2_login_leases`，创建短期 `LoginThrottleReservation` 表并通过 `keyHash` 外键关联现有 `LoginThrottle`。既有 `LoginThrottle.inFlightCount`、失败计数和窗口时间不被清空；旧的未归属 in-flight 数量会在下一次同账号预留时按仍有效的租约重新核对。没有修改已应用迁移、没有 reset、没有无条件清空用户数据库。

历史复合身份指纹仍按 `LEGACY_UNKNOWN`/阻塞处理，不能拆出 nativeId 或主页；缺少旧 HMAC key 的历史抑制只报告不可验证，不伪造旧 key，也不重新保存原始联系人作为黑名单。回滚使用停服务、已验证整库备份和匹配旧代码前向恢复，不执行 down migration。

## 实际验证

最终 PR CI `35356773077`：

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 退出码 0 |
| `pnpm db:generate` | 退出码 0 |
| `pnpm db:migrate` | 隔离 PostgreSQL 成功，12 条迁移全部应用，退出码 0 |
| `pnpm lint` | 退出码 0 |
| `pnpm typecheck` | 退出码 0 |
| `pnpm test:unit` | 9 files，132 passed，0 failed，0 skipped |
| `pnpm test:integration` | 8 files，69 passed，0 failed，0 skipped |
| `pnpm test:e2e` | 10 passed，0 failed，0 skipped |
| `pnpm build` | CI Turbopack 成功，退出码 0 |

本地已运行并通过：`pnpm db:generate`、`pnpm typecheck`、`pnpm test:unit`（132）、`pnpm lint`、`pnpm exec next build --webpack`、`git diff --check`。本机未运行 `pnpm db:migrate`、`pnpm test:integration`、`pnpm test:e2e`，因为缺少受保护的 `TEST_DATABASE_URL`/`TEST_DATABASE_NAME`/`TEST_RUN_ID`，没有访问用户开发库或生产库。项目默认 `pnpm build` 在本机因 Turbopack 子进程绑定端口被沙箱拒绝而失败，CI 项目脚本已成功；本地 webpack 构建通过。

## 未完成项

- R03/R04 的生产级屏障调度、数据库故障注入和多进程压力仍以隔离 CI 回归为边界，负责人复核前不宣称生产级恢复保证。
- 尚未部署生产恢复调度、告警、代理 query token 脱敏和真实备份 A→隔离库 B 的运行演练。
- T08/T09 继续关闭态预检；没有平台凭据、Cookie、真实平台请求、真实联系人提取或批准。
- 不承诺回收用户已经下载到外部的 CSV。

PR 保持未合并，等待负责人复核。

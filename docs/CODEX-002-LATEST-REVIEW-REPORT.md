# CODEX-002-LATEST-REVIEW · 生命周期一致性、恢复重放与登录并发

## 状态

本报告的 R01–R06 结论已由 `CODEX-002-RECHECK-R2` 复核；在 R2 修复提交完成并通过新的 CI 前，不应将本报告单独视为生命周期一致性、恢复重放或登录并发的完整验收。R2 当前报告见 [CODEX-002-RECHECK-R2-REPORT.md](./CODEX-002-RECHECK-R2-REPORT.md)。

本轮已追加到 [PR #2](https://github.com/Danbao0911/test3/pull/2) 的
`codex/002-contact-review`，最新经过 CI 验证的代码提交为
`a8c57130bc3efc6f67c00e0ed9f4952a2e53df8d`。没有修改 `main`、强推、合并或部署，T08 仍为关闭态预检，真实平台请求、生产凭据、真实联系人提取和批准均未开启。

实现提交链：

- `c0bac42bcd1542dd3e64e71456ae252fa36e9419`：R01–R06 主实现及真实恢复/登录测试。
- `080cdeb8fd8cef398fe2043bf5daab527964df6a`：新增恢复测试夹具的删除规则清理。
- `44565c23e8ca1e45c52c50610c900b4af223c9ae`：关联审核夹具的抑制记录清理。
- `b693ab2d0ae93f6dfca86faff0de19ad1fb12c84`：生命周期同步屏障竞态测试。
- `a8c57130bc3efc6f67c00e0ed9f4952a2e53df8d`：接受删除先提交时下载返回 404 的受控竞态结果。

最终 Push CI：[35349626419](https://github.com/Danbao0911/test3/actions/runs/35349626419)；最终 PR CI：[35349632722](https://github.com/Danbao0911/test3/actions/runs/35349632722)。两者的 `verify` 和 `e2e` 均成功。

报告及 PR 描述随后追加到提交 `69b120a06f1ed49f41efc878a716695ccf05ade8`；该最终文档 HEAD 的 Push CI 为 [35350044972](https://github.com/Danbao0911/test3/actions/runs/35350044972)，PR CI 为 [35350052032](https://github.com/Danbao0911/test3/actions/runs/35350052032)，同样全部成功。

## R01–R07 修改与测试映射

| 项目 | 实现位置 | 真实测试 |
| --- | --- | --- |
| R01 独立身份删除规则 | `src/lib/data-protection.ts`、`src/lib/identity-rules.ts`、`src/lib/import-service.ts`、`src/lib/retention-service.ts`、`prisma/schema.prisma` | `tests/integration/account-import.integration.test.ts` 的单条/CSV/漏填 ID 重录阻止；`tests/unit/t07-retention.test.ts` 指纹边界；恢复重放集成测试 |
| R02 全范围恢复重放 | `src/lib/retention-service.ts`、`scripts/retention-maintenance.ts`、`docs/T07-RETENTION-RUNBOOK.md` | `tests/integration/latest-review.integration.test.ts` 在真实 PostgreSQL 中建立 205+205 条数据，规则位于索引 100、204，首批零命中、游标续跑、重复重放、旧 key 和未知规则均有断言 |
| R03 统一锁序 | `src/lib/resource-locks.ts`、`src/lib/export-service.ts`、`src/lib/retention-dependencies.ts`、`src/lib/retention-service.ts`、`src/lib/contact-service.ts` | `tests/integration/t07-export-retention.integration.test.ts` 的同步屏障测试覆盖下载↔删除、抑制↔提取、抑制↔批准；下载竞态允许 200、对象已删的 404 或终态拒绝 410，但禁止 5xx，并检查最终数据库状态 |
| R04 直接删除的全局抑制 | `src/lib/retention-service.ts`、`src/lib/contact-policy.ts`、`src/lib/contact-service.ts`、`src/lib/account-workspace.ts`、`src/lib/account-link-service.ts`、`src/lib/export-service.ts` | T07 真实 HTTP 测试覆盖联系人删除、账号删除、跨账号/来源同值副本；列表、审核、导出和重新提取均按全局规则阻止，不同值不受影响 |
| R05 关系引用有效性 | `src/lib/account-link-service.ts`、`src/lib/retention-dependencies.ts`、`prisma/schema.prisma` | `tests/integration/account-link-review.integration.test.ts` 的 `LATEST-R05` 覆盖 MANUAL 关系引用在 INVALID、过期、抑制和引用证据删除后的读取结果，保留历史并返回明确不可用原因 |
| R06 登录并发准入 | `src/app/api/auth/login/route.ts`、`prisma/schema.prisma`、迁移 `20260919010000_latest_review_identity_login` | `tests/integration/account-import.integration.test.ts` 的真实 HTTP 测试：已有 9 次失败时并发 12 次错误登录，1 次进入密码校验并返回 401，11 次返回 429；`inFlightCount` 最终为 0，窗口到期后成功登录恢复 |
| R07 回归与交付 | 上述文件及既有 T05–T08 代码 | 冻结依赖、迁移、lint、typecheck、unit、integration、E2E、build 全部在 CI 执行；保留 90 行导入、来源/角色、审核、关联、工作台、导出清单和 T08 关闭态回归 |

## 关键实际结果

- 独立身份规则不再要求 native ID 和规范主页同时存在：任一仍有效的“平台+ID”或“平台+主页”规则命中都会阻止单条、CSV 和恢复重放；昵称、头像、跨平台同名不会被用作删除依据。旧复合指纹无法拆分时保留 `LEGACY_UNKNOWN`，不伪造新身份。
- 恢复服务按账号和联系人分别使用稳定 ID 游标，并返回 `scanned`、`matched`、`deleted`、`hasMore` 和续跑游标。真实测试断言至少 3 批、扫描账号不少于 408、联系人 205，删除账号 2、联系人 3，未知算法规则计入阻塞；重复重放删除数为 0。
- 所有跨服务事务使用 `source → fingerprint → account → contact → evidence → account-link → export-job` 顺序，并在加锁后重新读取。同步屏障竞态未产生 5xx；删除先提交时下载只得到 404，下载先提交时只能得到一次成功，抑制后所有同值副本为 `INVALID/suppressed`。
- 直接删除账号或联系人会调用共享全局抑制逻辑，覆盖已有同值副本及后续可用性检查；不物理删除请求范围之外的账号，也不因抑制期结束自动恢复旧批准。
- MANUAL 关系读取不再只检查 `Evidence.id`，而是重新检查引用联系的状态、双确认、期限、来源策略、快照和全局抑制。删除引用证据后返回 `LINK_EVIDENCE_REFERENCE_MISSING`，不把 `SET NULL` 当成独立证据。
- 登录预留在账号级 advisory lock 下计数，失败释放和异常释放均有界；成功登录不消耗失败额度，不信任转发头，不把密码、session 或 token 写入日志。

## 迁移与旧数据影响

新增且只追加 `prisma/migrations/20260919010000_latest_review_identity_login/migration.sql`：

- `DeletionRequest` 增加独立 native/profile 身份指纹和索引；无法从旧复合指纹恢复的历史记录标为 `LEGACY_UNKNOWN`。
- `LoginThrottle` 增加 `inFlightCount`，旧数据默认初始化为 0。
- 没有修改已应用迁移、没有 reset、没有清空用户数据库；CI 只在通过保护检查的临时 PostgreSQL 库执行迁移。
- 历史旧 key、未知算法或缺失 key 不会静默放行恢复：当前测试将其报告为 `blockedRules`。规则的范围、版本、期限和 key id 继续保留；尚未部署生产恢复调度。

## 命令、数量与本地/CI 边界

最终 PR CI 实际执行并成功：

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 退出码 0 |
| `pnpm db:generate` | 退出码 0 |
| `pnpm db:migrate` | 隔离 PostgreSQL 成功，退出码 0 |
| `pnpm lint` | 成功，退出码 0 |
| `pnpm typecheck` | 成功，退出码 0 |
| `pnpm test:unit` | 8 files，126 passed，0 failed，0 skipped |
| `pnpm test:integration` | 7 files，67 passed，0 failed，0 skipped |
| `pnpm test:e2e` | 10 passed，0 failed，0 skipped |
| `pnpm build` | 成功，退出码 0 |

本地已运行并通过：`pnpm db:generate`、`pnpm typecheck`、定向 `tests/unit/t07-retention.test.ts`（4 passed）和 `git diff --check`；此前本地完整 unit、lint 和 Webpack 构建也通过。集成/E2E/`db:migrate` 未在本机运行，因为没有 `TEST_DATABASE_URL`、`TEST_DATABASE_NAME`、`TEST_RUN_ID` 组成的受保护隔离库，保护脚本在访问数据库前拒绝；没有访问用户开发库或生产库。项目默认 Turbopack 构建受本机沙箱内部进程限制，正式 `pnpm build` 以 CI 成功结果为准。

本轮出现过的非最终失败也保留记录：CI `35348461717` 仅因新增集成夹具未先清理 `ContactSuppression` 外键失败，已由 `080cdeb`、`44565c2` 修复；CI `35349388722` 仅因并发删除先提交时实际返回 404 而测试只接受 200/410，已由 `a8c5713` 修正。最终 CI `35349632722` 全部通过，未使用 skip、删除断言或 continue-on-error。

## 尚未完成与安全回滚

本轮仍标记为“部分完成”：尚未执行真实备份 A 到隔离恢复库 B 的完整恢复重放演练，尚未验证清理 CLI 在实际中断后跨批次恢复，也没有部署生产调度和告警。不能承诺回收用户已下载到外部的 CSV，不能把绿色 CI 表述为生产上线或四平台自动采集完成。

安全回滚方式是停止相关服务，使用已验证的整库备份和匹配的旧代码前向恢复；不执行 down migration、reset 或无条件删除。恢复演练必须在隔离库导入带范围/版本/期限/key id 的删除与抑制规则，并继续保持真实联系人开关关闭。PR #2 保持未合并，等待负责人复核。

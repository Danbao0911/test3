# CODEX-002-T10 · 测试、部署与运行说明

## 结论

T10 本轮为“隔离自动化与恢复演练通过，生产发布仍阻塞”。实现提交为 `d4d9ea54a8eb7b39b940ab40ee201d3bdcad15b9`，已推送到 [PR #2](https://github.com/Danbao0911/test3/pull/2)。最终隔离 CI：[Push run 35360789725](https://github.com/Danbao0911/test3/actions/runs/35360789725) 与 [PR run 35360799409](https://github.com/Danbao0911/test3/actions/runs/35360799409) 均成功。

本轮没有修改 `main`、没有强推、没有合并、没有部署生产、没有接收真实平台凭据，也没有开启真实联系人提取或批准。任务书要求的真实平台能力、生产告警通道、生产备份存储和上线后闭环尚未验证，因此不能写成整体项目完成。

## 修改位置与验收映射

| 范围 | 修改 | 验证 |
| --- | --- | --- |
| 隔离运行预检 | `src/lib/operational-controls.ts`、`scripts/t10-preflight.ts` | CI 在迁移前后以 `APP_MODE=test`、绑定 `TEST_RUN_ID` 的专用库运行；平台请求 0、自动重试 0；配置平台凭据会阻断且不输出值 |
| 备份/恢复/规则重放 | `scripts/t10-recovery-drill.ts` | 独立 CI job 使用真实 PostgreSQL、`pg_dump`/`pg_restore`、真实 `deleteTarget` 和 `replayDeletionRules`；恢复后查询账号/联系人均不可用，重复重放无变化 |
| 测试与证据 | `.github/workflows/ci.yml`、`playwright.config.ts` | verify、E2E、recovery 三个 job；E2E 成功截图/录像上传 7 天，artifact 只来自合成数据 |
| 单测与命令 | `tests/unit/t10-operations.test.ts`、`package.json` | T10 操作控制 4 个单测；新增 `pnpm t10:preflight` 和 `pnpm t10:recovery:drill` |
| 部署/回滚/告警说明 | `docs/T10-RUNBOOK.md`、`README.md` | 记录隔离前置、迁移、恢复、checkpoint、退出码、告警边界和前向回滚，不虚构生产调度 |

## 实际 CI 结果

最终 Push/PR CI 均执行以下实际命令，失败和跳过均为 0：

| Job / 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 成功，退出码 0 |
| `pnpm db:generate` | 成功，退出码 0 |
| `pnpm test:unit` | 10 files，136 passed，0 failed，0 skipped |
| `pnpm exec tsx scripts/prepare-ci-database.ts` | 两个普通回归库及 T10 专用库均初始化为非特权 `test3` 角色 |
| `pnpm db:migrate` | 隔离 PostgreSQL 成功，现有 12 条迁移按顺序应用；本轮无新迁移 |
| `pnpm t10:preflight` | `status=ready`，目标为 `127.0.0.1` 的 run-bound 测试库 |
| `pnpm lint` / `pnpm typecheck` | 均成功，退出码 0 |
| `pnpm test:integration` | 8 files，69 passed，0 failed，0 skipped |
| `pnpm build` | CI 成功，退出码 0 |
| `pnpm test:e2e` | 10 passed，0 failed，0 skipped，重试 0 |
| E2E artifact | 成功上传 [e2e-evidence-35360789725](https://github.com/Danbao0911/test3/actions/runs/35360789725/artifacts/10553639244)，约 4.7 MiB，保留 7 天 |
| `T10_RECOVERY_CONFIRM=1 pnpm t10:recovery:drill -- --execute` | 独立 `t10-recovery-drill` job 成功，退出码 0 |

恢复演练的实际 JSON 结果为：基线 dump `84203` bytes，规则 dump `2354` bytes；恢复库第一次重放 `deletedAccounts=1`、`complete=true`，数据库查询确认基线账号和联系人均不存在；第二次重放 `deletedAccounts=0`、`deletedContacts=0`、`complete=true`。联系人删除计数为 0 是因为账号删除的级联已经移除联系人，不是跳过断言。演练结束后临时恢复库、fixture 和 dump 均清除。

本轮曾有三次真实 CI 失败，均已修复并保留在历史 run 中：合成 APPROVED 联系人缺少 `reviewedAt`；runner 默认 `pg_dump` 工具不适配 PostgreSQL 17；工具容器未挂载宿主临时 dump 目录。最终 run 通过同样的真实数据库约束和工具流程，未用 skip 或重试掩盖问题。

## 本地与 CI 的区别

本地已运行并通过：`pnpm db:generate`、`pnpm test:unit`（136）、`pnpm typecheck`、`pnpm lint`、`pnpm exec next build --webpack`、`git diff --check`；在受控命令执行环境中，`pnpm t10:preflight` 返回 ready，恢复命令默认 dry-run 返回安全计划。

本地没有受保护的 PostgreSQL 测试库，因此没有运行 `pnpm db:migrate`、`pnpm test:integration`、`pnpm test:e2e` 或恢复演练的 `--execute`，没有访问开发库或生产库。默认 `pnpm build` 在此前本机受限环境因 Turbopack 子进程/端口限制失败；本轮 CI 的 `pnpm build` 已成功，不能把本地 webpack 构建等同于默认脚本的本地通过。

## 数据、迁移与回滚

本轮无 Prisma schema 变更、无新增迁移、无已应用迁移修改。CI T10 使用 `test3_test_<run>` 源库和 `test3_recovery_<run>` 临时恢复库；仅建立本轮虚构账号、证据、联系人及删除/抑制规则。dump 通过同版本 `postgres:17.6-alpine` 工具容器完成，密码只经进程环境传递，错误摘要脱敏。

回滚使用上一份已验证代码的前向 revert 或恢复旧应用镜像；不执行 down migration、不删除生产数据、不用恢复演练库替代生产恢复。若上线版本已写入新数据，先停止写入、保留审计并在隔离副本验证前向修复。已下载到外部的 CSV 不承诺可回收。

## 告警、预算与未完成项

- 平台 transport 仍是 hard stop：`externalRequestsEnabled=false`、`maxRequests=0`、`automaticRetries=0`；T08/T09 真实平台调用继续关闭。
- CI 失败、迁移失败和维护命令非零退出是发布阻断。已有维护命令的退出码 `2`/`3` 分别表示需要 checkpoint 续跑/存在未知规则或缺失 key，不得宣称恢复完成。
- 生产告警接收人、值班系统、预算仪表盘和生产恢复调度为 `not_deployed`，本轮只把策略和退出码写入运行手册。
- 没有执行真实数据试点、生产数据库不公开性验收、正式部署后的 health/权限/导出闭环或任何平台 API 调用。
- 因此本报告结论是“隔离测试与恢复演练通过、生产上线条件未满足”，不是“整体已完成”。


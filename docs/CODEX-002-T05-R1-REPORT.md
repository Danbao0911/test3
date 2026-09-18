# CODEX-002-T05-R1 账号工作台整改交付报告

## 交付状态

T05-R1 已完成并追加更新现有 [PR #2](https://github.com/Danbao0911/test3/pull/2)，PR 仍为 `OPEN`。最终 head 为：

- 仓库：`Danbao0911/test3`
- 分支：`codex/002-contact-review`
- 最终完整 SHA：`60344cde5bbf49b21eba1d4a439d2530ac2071a3`
- 本轮功能提交：`2ab27e2`；测试隔离修复：`4b53cc1`；最终 E2E 断言修复：`60344cd`
- Push CI：[35315241700](https://github.com/Danbao0911/test3/actions/runs/35315241700)，`success`
- PR CI：[35315245304](https://github.com/Danbao0911/test3/actions/runs/35315245304)，`success`

未修改 `main`，未强推，未自动合并，未部署生产。本轮不开放真实联系人提取或批准，不开发平台爬虫、外联或导出。

## W01—W06 修改与测试映射

### W01：个人收藏隔离与并发幂等

- `src/lib/account-workspace.ts`：`accountWorkspaceInclude(userId)` 对 `favorites` 使用服务端用户 ID、必要字段和最多一条记录；列表/详情/PATCH DTO 统一按当前用户计算 `favorite`。
- `src/lib/account-workspace-service.ts`：收藏变更在账号行锁事务内完成；POST 表示设为收藏，DELETE 表示设为未收藏；同状态重试不写审计，避免捕获唯一冲突后继续使用失败事务。
- `src/app/api/accounts/[id]/favorite/route.ts`、`src/app/api/accounts/route.ts`：不读取客户端 `userId`，维护权限和筛选均按当前会话。
- 测试：`tests/integration/account-workspace-review.integration.test.ts` 的 T05W01/W02 覆盖四个独立身份、A/B 隔离、YES/NO 筛选、重复并发 POST/DELETE、单条收藏和单次状态变更审计。

### W02：workspaceVersion 与一次原子保存

- `prisma/schema.prisma`、`prisma/migrations/20260918190000_account_workspace_version/migration.sql`：新增 `Account.workspaceVersion`，旧数据默认初始化为 1。
- `src/lib/account-workspace-service.ts`：统一锁定账号、校验版本、校验负责人、更新跟进和写最小审计；实际变化才升版本；负责人和跟进同事务提交。
- `src/app/api/accounts/[id]/workspace/route.ts`、`src/app/api/accounts/[id]/route.ts`、`src/app/api/accounts/[id]/follow-up/route.ts`、`src/lib/validation.ts`：新增严格 workspace PATCH，旧入口也要求版本校验并路由到同一服务；`DO_NOT_CONTACT` 恢复必须明确确认并填写理由。
- `src/components/account-detail.tsx`：保存按钮只调用一次原子接口；409 保留草稿，不用最新版本自动重试。
- 测试：T05W03/W04、T05W09/W10，以及 `tests/integration/account-import.integration.test.ts` 的现有工作台回归。

### W03：VIEWER 备注脱敏

- `src/lib/account-workspace.ts`：用显式白名单 DTO 替代开放式透传；来源只返回工作台所需字段；ADMIN/REVIEWER 可读自由文本备注，VIEWER 返回 `note: null` 与 `noteMasked: true`。
- `src/components/accounts-page.tsx`、`src/components/account-detail.tsx`：显示“备注受权限限制”，不会把隐藏备注当空字符串写回。
- 测试：T05W05 直接检查维护者与 VIEWER 的 JSON、列表/详情响应和页面 DOM；合成邮箱、电话、微信、证据链接及文本哨兵均未出现在 VIEWER 响应或 DOM 中。

### W04：收藏、筛选和保存界面一致

- `src/components/accounts-page.tsx`：服务端返回值作为收藏最终状态；筛选条件区分草稿/已应用；列表请求使用 `AbortController` 与请求代数；收藏操作有忙状态，成功后刷新列表和 total，并处理最后一页移除。
- `src/components/account-detail.tsx`：工作台原子保存、401/403/409、网络错误和非 JSON 错误均恢复按钮并保留草稿。
- 测试：`tests/e2e/account-workspace-review.spec.ts` 覆盖两个浏览器上下文的旧版本冲突、草稿保留、收藏筛选刷新和延迟旧筛选响应不覆盖最新响应。

### W05：空范围与受控查询

- `src/lib/account-workspace.ts`、`src/app/api/accounts/route.ts`：`findUsableAccountIds(db, [])` 立即返回空 `Set`，不访问数据库；列表页和 total 使用同一参数化谓词；`hasContact` 通过数据库 EXISTS/NOT EXISTS 逻辑在当前页筛选，不物化全量账号 ID。
- 测试：`tests/unit/account-workspace.test.ts` 验证空数组零数据库调用；T05W06/W07 覆盖收藏分页、空结果和 total；T05W08 覆盖来源撤销后列表/详情一致性。查询计划未在本机执行，CI 使用隔离 PostgreSQL 完成真实 HTTP 验收。

### W06：真实验收与证据

- 新增 `tests/unit/account-workspace.test.ts`、`tests/integration/account-workspace-review.integration.test.ts`、`tests/e2e/account-workspace-review.spec.ts`。
- 更新 `tests/integration/account-import.integration.test.ts`、`tests/integration/policy-history-migration.integration.test.ts`，保留原有来源策略版本、历史快照、权限、联系审核、撤销/到期和 90 行导入回归。
- `vitest.config.mts` 将集成文件串行化；每个 HTTP 测试使用隔离端口和进程组清理，避免 Next 开发锁互相污染。
- 报告同步更新至本文件及 `docs/CODEX-002-T05-REPORT.md`。

## 实际结果

最终 CI 的真实验收结果如下：

- 多用户收藏：REVIEWER A 收藏后 A 的列表/详情为 `favorite=true`，REVIEWER B 为 `false`；B 的 YES 不包含、NO 包含；B 取消不影响 A。
- 收藏并发：同用户并发 POST 均返回 200，最终一条收藏；并发 DELETE 均返回 200，最终零条收藏；无变化重试不重复写成功变更审计；VIEWER 写入均为 403。
- 版本冲突：B 先保存 `DO_NOT_CONTACT` 后，A 使用旧 `workspaceVersion` 返回 409、`error=WORKSPACE_CONFLICT`；B 的负责人、状态和备注保持不变。
- 原子回滚：在负责人更新后注入故障，接口返回 500；负责人、跟进、版本和成功审计全部回滚。
- 备注权限：ADMIN/REVIEWER 可读，VIEWER 的 JSON、列表、详情和 DOM 均不含备注哨兵或联系示例值。
- 来源变化：来源撤销后，列表和详情都将联系方式标为不可用；没有绕过当前来源策略恢复旧批准。
- 筛选竞态：延迟的旧平台响应不会覆盖较新的筛选结果；收藏筛选取消后当前账号从该筛选结果和 total 中移除。
- 旧数据：迁移后的已有账号 `workspaceVersion=1`，跟进为中性的 `NOT_CONTACTED`；未从旧数据推断负责人、收藏或人工行为。

## 测试统计

最终 Push CI `35315241700` 和对应 PR CI `35315245304` 均为绿色。最终 Push CI 的测试计数：

| 阶段 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| `pnpm test:unit` | 94 | 0 | 0 |
| `pnpm test:integration` | 42 | 0 | 0 |
| `pnpm test:e2e` | 6 | 0 | 0 |
| `pnpm lint` | 1 次命令成功 | 0 | 0 |
| `pnpm typecheck` | 1 次命令成功 | 0 | 0 |
| `pnpm build` | 1 次命令成功 | 0 | 0 |

集成测试为 3 个文件、42 个测试：原有账号导入/权限/联系人回归 35 个、T05-R1 多用户 HTTP 合约 6 个、迁移测试 1 个。E2E 为 6 个测试，全部通过。最终没有 skip；早期修复迭代的失败 run `35314498103`、`35314764793`、`35315047537` 未作为交付依据，最终 run 已重新完整执行。

## 迁移、旧数据和回滚

- 新增迁移只追加 `Account.workspaceVersion INTEGER NOT NULL DEFAULT 1`，不修改已应用迁移、不清空数据库。
- 已有工作台数据保留；版本从 1 开始，现有跟进补为中性状态，不伪造历史负责人、收藏或人工备注。
- 本机没有可用隔离 PostgreSQL/Docker，因此没有对开发库执行迁移，也没有操作生产库。CI 在受保护的临时 PostgreSQL 中实际执行 `pnpm db:migrate`、集成测试和 build。
- 回滚方案：停止应用并使用已验证的数据库备份恢复到迁移前版本，同时回滚应用到迁移前提交；不执行未经验证的 down migration，不对用户数据库运行无条件删除。

## 本地与 CI 边界、未完成项

本地已运行并通过：`pnpm db:generate`、`pnpm test:unit`（94/94）、`pnpm lint`、`pnpm typecheck`、`git diff --check`。本地未运行：`pnpm install --frozen-lockfile`、`pnpm db:migrate`、`pnpm test:integration`、`pnpm test:e2e`、`pnpm build`；这些均由最终 CI 在隔离环境中实际运行并通过。

未完成或明确不在本轮范围：T06/T07 平台采集、真实外联、真实联系人提取/批准、抑制系统、物理删除和受控导出。绿色 CI 不代表生产上线，不代表已经具备四平台自动采集能力。PR #2 保持打开，未自动合并。

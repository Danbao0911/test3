# CODEX-002-T05 账号工作台与跟进管理交付报告

## 交付状态

T05 已完成并更新现有 [PR #2](https://github.com/Danbao0911/test3/pull/2)。本轮只实现账号工作台、收藏、负责人和人工跟进，不开始新的平台采集，不开放真实联系人。

- 仓库：`Danbao0911/test3`
- 分支：`codex/002-contact-review`
- PR：[#2](https://github.com/Danbao0911/test3/pull/2)，当前状态 `OPEN`
- 最终功能提交：`5af49418c5fe080ea2c970824fa35d07d33988f0`
- Push CI：[35310973764](https://github.com/Danbao0911/test3/actions/runs/35310973764)
- PR CI：[35310977293](https://github.com/Danbao0911/test3/actions/runs/35310977293)
- 两条 CI 均为 `success`，未跳过测试、未自动重试。

## 修改内容

### 数据模型与迁移

- `prisma/schema.prisma`：新增 `FollowUpStatus`；账号负责人关系；每用户收藏 `AccountFavorite`；每账号一条当前人工跟进状态 `AccountFollowUp`。
- `prisma/migrations/20260918180000_account_workspace/migration.sql`：追加迁移，不修改既有迁移、不清空数据库。
- 已有账号只补入中性的 `NOT_CONTACTED` 跟进状态，不推断历史人工行为；负责人为空，收藏为空。账号删除时关联工作台记录按外键清理，负责人删除则置空。

### API 与安全边界

- `src/app/api/accounts/route.ts`：账号列表新增服务标签、联系审核状态、当前可用联系方式、跟进状态、当前用户收藏筛选。
- `src/app/api/accounts/[id]/route.ts`：详情返回负责人、收藏、跟进和脱敏的联系可用性；资料修改支持负责人变更并记录审计。
- `src/app/api/accounts/[id]/favorite/route.ts`：按用户收藏/取消收藏；只允许维护角色写入。
- `src/app/api/accounts/[id]/follow-up/route.ts`：保存人工跟进状态和备注；备注限长 1000 字，写入审计。
- `src/app/api/users/route.ts`：仅向管理员/审核员提供负责人下拉所需的最小用户字段。
- `src/lib/account-workspace.ts`：只依据当前来源授权、策略版本、证据状态、双确认和有效期计算 `hasUsableContact`；列表和详情不返回联系原值、规范值或证据正文。

VIEWER 仍可按最小字段查看，但不能收藏、改负责人或写跟进。跟进状态只记录人工动作，不代表系统已经发送邮件、私信或拨打电话；人工双确认、来源撤销/到期拦截、策略版本校验和三角色权限保持不变。

### 页面

- `src/components/accounts-page.tsx`：账号工作台列表、筛选、当前联系方式可用性、审核状态、负责人、跟进状态/备注和收藏操作。
- `src/components/account-detail.tsx`：账号详情中的收藏、负责人、跟进状态和备注维护，并明确显示“人工跟进不等于系统外联”。
- `src/app/accounts/page.tsx`：按角色控制维护能力。

## 实际验收结果

集成测试中的 `T05 账号工作台支持筛选、收藏、负责人和人工跟进` 使用真实 HTTP 接口验证：

- 按服务标签、联系审核状态、`hasContact`、跟进状态和收藏状态筛选。
- 收藏后可按当前用户查询；取消收藏后不可见。
- 负责人写入、清空、跟进状态和备注保存可在详情接口读回。
- 账号存在已批准且当前仍可用的联系方式时才报告可用；来源撤销、策略变化、过期或版本不一致不会被工作台绕过。
- VIEWER 的用户列表、收藏写入和跟进写入均被拒绝；只读详情仍不暴露联系原值。

E2E 新增 `tests/e2e/account-import.spec.ts` 的“账号工作台—收藏—负责人—人工跟进—筛选”，并保留原有导入和联系审核浏览器验收。

## CI 统计

最终 Push CI `35310973764` 的实际结果：

| 阶段 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| `pnpm install --frozen-lockfile` | 2 | 0 | 0 |
| `pnpm db:generate` | 2 | 0 | 0 |
| `pnpm test:unit` | 92 | 0 | 0 |
| `pnpm db:migrate` | 2 | 0 | 0 |
| `pnpm lint` | 1 | 0 | 0 |
| `pnpm typecheck` | 1 | 0 | 0 |
| `pnpm test:integration` | 36 | 0 | 0 |
| `pnpm build` | 1 | 0 | 0 |
| `pnpm test:e2e` | 4 | 0 | 0 |

集成测试为 2 个测试文件、36 个测试：账号导入/策略/联系审核 35 个，旧数据策略快照迁移 1 个。E2E 为 4 个测试，包含新增 T05 场景。PR CI `35310977293` 对同一完整 SHA 重复验证并成功。

## 本地与 CI 边界

本地已运行 `pnpm db:generate`、`pnpm test:unit`、`pnpm lint`、`pnpm typecheck` 和 `git diff --check`；均通过。由于本机没有可用的隔离 PostgreSQL/Docker，本地未运行 `pnpm db:migrate`、`pnpm test:integration`、`pnpm test:e2e`、`pnpm build`；这些步骤已在 CI 的隔离数据库和浏览器环境中实际通过。

## 未解决项和边界

- T06/T07 尚未开始：不包含平台采集、真实数据外联、物理删除、抑制、到期清理或受控导出。
- 生产环境仍禁止真实联系人提取和批准；本轮不表示生产上线。
- 未自动合并 PR、未修改 `main`、未部署生产。

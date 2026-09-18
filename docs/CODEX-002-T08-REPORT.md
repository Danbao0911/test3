# CODEX-002-T08 · 平台接入前置研究与能力边界

## 范围和状态

继续在 `codex/002-contact-review` 更新 [PR #2](https://github.com/Danbao0911/test3/pull/2)，本轮最终实现 SHA 为 `d97a489582395a32b7cb4839f280c44666e78893`。完成 T08 的官方文档核查、本地平台状态、统一关闭态适配器和来源预检。T08 整体为部分完成：项目应用授权、scope、预算、真实调用样例和 T07 生命周期运行验收尚未具备，因此真实 transport、搜索、刷新和删除同步未开放。

本报告对应的真实隔离 CI： [Push run 35343142423](https://github.com/Danbao0911/test3/actions/runs/35343142423) 与 [PR run 35343146237](https://github.com/Danbao0911/test3/actions/runs/35343146237)，均成功。PR #2 同时保留 T05、T06、T07 的既有交付和各自报告；本轮只追加平台接入前置能力，不宣称真实平台采集已完成。

## 实现与测试映射

| 交付 | 代码 | 验证 |
| --- | --- | --- |
| 四平台统一能力接口 | `src/connectors/types.ts`、`registry.ts` | `platform-adapters.test.ts` 调用全部 16 个方法，均无成功数据及 fetch；所有运行模式和伪造环境凭据均不开放能力 |
| 数据库驱动来源预检 | `src/lib/platform-service.ts`、`src/app/api/platforms/preflight/route.ts` | T08C03/C04/C05：全权限人工来源仍被拒；409、撤销、到期、缺失/legacy 快照；不增加账号、证据、导出或成功审计 |
| 鉴权及最少响应字段 | `/api/platforms`、`/api/platforms/sources` | T08C01/C02/C06：三种独立身份，401/403，来源白名单，20 条游标分页，原文哨兵不出现在平台 API/页面 |
| 有界请求、无任意外联入口 | 预检 schema、已有 `readBoundedJson` | T08C02：未知字段/凭据/URL 422、错误 JSON 400、无 Content-Length 流式超限 413、跨源 403 |
| 中文能力矩阵和可操作预检 | `/platforms`、`platforms-page.tsx`、导航 | 两个 Playwright 用例：四平台外部搜索禁用、真实 HTTP 预检、旧策略冲突保留选择、网络与非 JSON 失败恢复按钮 |
| 官方资料与真实验证分开登记 | `docs/SOURCE_REGISTER.md` | YouTube/X 核查官方文档，应用真实调用记录留空；小红书/抖音标记待 T09，不借文档示例填补验证 |

预检属于只读诊断，200 不代表平台调用成功。所有业务方法只返回关闭原因，无外部调用、任务投递、账号写入或凭据输入入口。来源预检结果不能用于以后真实执行授权。

## 验证记录

本地已运行：`pnpm install --frozen-lockfile`、`pnpm db:generate`、`pnpm test:unit`、`pnpm lint`、`pnpm typecheck`、`pnpm exec next build --webpack` 和 `git diff --check`，均退出码 0；单元测试 125 通过、0 失败、0 跳过，Webpack 构建生成 30 个页面/路由。

本地默认 `pnpm build` 退出码 1，失败原因是当前受限运行环境禁止 Turbopack 内部进程绑定端口；这不记为本地通过。因本机未提供通过保护检查的隔离 PostgreSQL 测试库，`pnpm db:migrate`、`pnpm test:integration`、`pnpm test:e2e` 未在本地执行；保护脚本拒绝启动，未触碰开发库或生产库。上述命令由隔离 CI 实际执行并计入下表，未运行部分不记为本地通过。

最终隔离 CI（对应实现 SHA `d97a489582395a32b7cb4839f280c44666e78893`）：

| 实际命令 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 成功 | 0 |
| `pnpm db:generate` | 成功 | 0 |
| `pnpm test:unit` | 8 files，125 通过，0 失败，0 跳过 | 0 |
| `pnpm db:migrate` | 隔离测试库成功 | 0 |
| `pnpm lint` | 成功 | 0 |
| `pnpm typecheck` | 成功 | 0 |
| `pnpm test:integration` | 6 files，61 通过，0 失败，0 跳过 | 0 |
| `pnpm test:e2e` | 10 通过，0 失败，0 跳过 | 0 |
| `pnpm build` | 成功 | 0 |

T08 新增单元测试覆盖 16 个平台适配器操作、伪造凭据不启用能力、严格请求 schema 和角色边界；新增集成测试 T08C01–C06 覆盖真实 HTTP、来源策略版本冲突、撤销/到期/legacy 快照、401/403/409/413 和最小响应；新增 E2E 覆盖四平台关闭态、预检、网络/非 JSON 错误及草稿选择保留。CI 还回归了 T05/T06/T07 与 90 行导入测试。为消除共享 CI 管理员登录造成的假失败，本轮把登录限流改为只累计失败尝试；成功登录不再消耗失败额度，失败尝试仍在 advisory lock 下限时计数并封顶。

## 数据影响与回滚

本轮无 schema 变更或新迁移；来源、账号、联系人、工作台、关联、导出与抑制表均无生产写入变化。预检使用只读查询和来源共享锁，与既有来源修改锁兼容，不写“批准”“验证成功”审计。测试仅清理当前 fixture 的 ID/actor 范围，保留原 90 行导入和既有全套回归。登录限流修复不改变表结构、角色权限或生产联系人开关。

回滚可恢复本轮前的代码版本或在开发分支前向 revert 本轮提交；无需数据库降级。真实联系人处理继续关闭，无 main 变更、强推、合并或生产部署。

## 未完成与外部阻塞

未获得并核验应用授权及本项目使用范围，未执行官方 API 最小真实调用；没有平台实际响应样例或实际费用/配额数字。可执行 transport、真实分页/重试、真实 429/配额耗尽/空结果验收和自动刷新/删除同步尚未实现。T07 备份恢复演练及调度运行验收仍未完成。CI 通过仅验证这次前置能力边界及项目回归，不表示 T08 真实接入或四平台采集完成。

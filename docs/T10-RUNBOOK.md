# T10 测试、部署、恢复与回滚运行手册

本手册对应任务书 T10。当前项目仍是“隔离测试/演示可运行、生产联系人处理关闭”的状态；没有生产部署、真实平台凭据、平台外联或后台调度。任何未通过本手册预检的命令都必须停止，不能用 `--force`、`reset`、无条件 `deleteMany` 或生产数据库替代演练。

## 运行边界

- 生产模式拒绝联系提取、批准、平台请求和恢复演练。
- T08/T09 的四个平台请求预算为 0，自动重试为 0；平台适配器不会发出外联请求。
- 测试只能使用本轮专用 PostgreSQL：`APP_MODE=test`、`TEST_DATABASE_MODE=isolated`、`DATABASE_URL === TEST_DATABASE_URL`、主机为 `127.0.0.1`，数据库名必须绑定 `TEST_RUN_ID`。
- CI 使用非特权 `test3` 角色；恢复演练额外使用仅用于创建/删除临时恢复库的 CI bootstrap 连接，不写入仓库、不输出日志。
- 截图、录像、CI artifact 只能使用 `example.com` 等虚构数据；不要将 `.env`、token、cookie、备份或真实联系值加入 GitHub。

## 启动前预检

冻结依赖、生成客户端和测试库迁移由 CI 执行。人工运行时先设置当前运行的隔离变量，再执行：

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm t10:preflight
```

预检只打印模式、数据库主机/名称、平台关闭态、告警要求和问题代码，不打印密码或完整连接 URL。退出码 `0` 表示配置可继续，退出码 `2` 表示阻断。`production` 不得用来运行恢复演练。

## 自动化验证

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm build
git diff --check
```

CI 的 verify 和 E2E job 使用不同的临时数据库。E2E 会保留合成数据的 screenshot/video artifact 7 天；artifact 不代表真实平台接入或生产验收。集成测试、E2E、迁移或 build 任一失败都属于发布阻断，不得改成 `skip` 或 `continue-on-error`。

## 备份/恢复/重放演练

演练命令默认是 dry-run；实际执行必须同时满足隔离库保护、临时 bootstrap 连接和显式确认：

```bash
pnpm t10:recovery:drill
T10_RECOVERY_CONFIRM=1 pnpm t10:recovery:drill -- --execute
```

CI 的 `t10-recovery-drill` job 会：

1. 在全新的临时库建立 schema 和非特权角色。
2. 创建多个带唯一标识的虚构账号、证据和联系方式；备份前先建立一条有效基线删除/抑制规则，再做一次真实 `pg_dump` 基线。
3. 备份后通过真实 `deleteTarget` 产生多个新增规则，并更新其中一条；将新增/更新规则写入带版本和备份截止时间的受控 JSON rule package，不把整张规则表再次 `pg_restore`。
4. 创建临时恢复库，真实 `pg_restore` 基线；核验操作人等外键依赖后按稳定规则 ID 合并 rule package 两次，第二次必须幂等。
5. 调用真实 `replayDeletionRules`，使用账号/联系人独立游标、`batchSize=1` 循环至扫描和执行完成；查询数据库确认至少两个目标不可用、无关哨兵保留，并做第二轮完整重放。
6. 断开连接后只删除本次成功创建并登记归属的临时恢复库、本轮 fixture 和临时文件；不强制断开未知连接。清理失败会与恢复验证分开报告，并以非零退出码结束。

脚本不接受生产数据库、不接受外部主机、不把原始 fixture 值写入 stdout；工具失败时只返回退出码和不含数据库工具原文的错误。规则包缺少备份库中的操作人/引用依赖或版本不受支持时明确失败，不伪造身份。若在 `--max-batches` 场景使用既有 `retention:replay`，输出 `incomplete` 和 checkpoint 时必须保存 checkpoint，并用同一 run ID、同一模式继续；不能把累计删除数或 dry-run 预览当成实际执行完成。

演练规则包协议当前为 v1：`backupCutoff` 标记备份时点，`capturedAt` 必须晚于该时点，规则以稳定 UUID 合并；同 ID 的重复包更新同一规则，不插入重复记录，也不会清空历史表。缺失依赖返回 `RULE_DEPENDENCY_MISSING`。这只是隔离恢复协议，尚未部署生产恢复调度或云备份服务。

这项演练验证的是隔离库中的恢复闭环，不等于已经建立云备份、异地副本或生产调度。真实部署前仍需由负责人登记备份存储、加密密钥、保留期限、恢复责任人和审计记录。

## 告警与预算

当前可执行的告警边界是 CI/job 失败和维护命令的非零退出码：

- CI、迁移和构建失败：发布阻断，通知由仓库/组织的 GitHub Actions 设置负责。
- 生命周期清理或规则重放返回 `2`：扫描未完成，需要使用 continuation checkpoint 续跑。
- 返回 `3`：存在未知规则、缺失 key 或未知算法，必须人工阻断，不能宣称恢复完成。
- 生产告警通道、值班系统、预算仪表盘：`not_deployed`，尚未配置。
- 平台外联预算：本地 hard stop 为 `maxRequests=0`、`automaticRetries=0`，不把它描述为厂商配额。

上线前必须先配置经审批的告警接收人和预算阈值；在此之前不得打开平台 transport、真实联系人提取或批准。

## 部署、回滚与数据保护

当前没有生产部署动作。未来若负责人批准部署，顺序必须是：隔离 staging 迁移与全套测试通过 → 备份并核对恢复点 → 发布应用 → 调用 `/api/health` → 用虚构/授权测试账号执行闭环验收 → 检查审计和告警。数据库迁移只能追加，不能修改已应用迁移或清空库。

回滚使用上一份已验证应用镜像/提交的前向回滚；不要执行 Prisma down migration，也不要回滚已经写入的生命周期规则。若新版本改变数据格式，先停止写入并按恢复演练流程在副本验证，再由负责人决定前向修复。已下载到用户外部的 CSV 无法由服务端回收。

发布记录必须包含 commit、CI run、迁移结果、health 结果、闭环验收结果、截图/录像 artifact 是否仅含合成数据，以及未验证的平台和剩余阻塞。没有这些证据只能写“部分完成”或“证据不足”。

# T07 生命周期维护运行说明

## 范围与安全边界

`retention:cleanup` 和 `retention:replay` 只允许在隔离的 `demo`/`test` 数据库运行。运行时会执行现有的 `DATABASE_URL`、`TEST_DATABASE_URL`、数据库名称和模式保护；生产模式直接拒绝。非 dry-run 还必须显式设置：

```text
RETENTION_MAINTENANCE_CONFIRM=1
RETENTION_MAINTENANCE_ACTOR_ID=<隔离库中的管理员或维护审计身份 UUID>
```

没有实际部署定时调度或告警；上线前应将失败退出码接入调度器告警。当前命令不会承诺回收用户已经下载到外部的 CSV。

## 到期清理

清理按最多 100 条一批，返回三个游标，支持中断后继续：

```bash
pnpm retention:cleanup -- --dry-run --batch-size 50
RETENTION_MAINTENANCE_CONFIRM=1 RETENTION_MAINTENANCE_ACTOR_ID="$ACTOR_ID" \
  pnpm retention:cleanup -- --batch-size 50 --max-batches 100
```

联系到期与手动删除共用依赖清理：先清除受影响的临时导出，再把 `AccountLinkEvidence.referenceEvidenceMissing` 标为 true，最后删除 Evidence（级联删除 ContactPoint）。清理不会用外键 `SET NULL` 推断“原本没有引用”。

## 恢复规则重放

账号删除规则分别保存“平台 + 稳定 ID”和“平台 + 规范主页”的独立指纹、限定范围、算法版本、期限和 HMAC key id。任一仍有效的规则命中都会阻止恢复；不要求两个身份同时出现，也不使用昵称、头像或跨平台同名推断。单条录入、CSV 导入和恢复重放共用同一身份规则服务。旧复合指纹无法拆回原始身份，追加迁移将其标记为 `LEGACY_UNKNOWN`，不伪造新指纹。

重放对账号和联系人使用独立的稳定 ID 游标。每次返回 `scanned`、`matched`、`deleted`、`hasMore` 和 `next.accountCursor`/`next.contactCursor`，并额外返回各范围的 `accountDone`/`contactDone`，因此首批零命中不会提前结束，也不会在另一范围仍有数据时重扫已完成范围。`--max-batches` 到达上限时输出 `incomplete: true`、续跑游标并以退出码 2 结束；只有两个范围都完成才输出 `complete: true`。

重放前按算法版本和 key id 选择规则：当前 v2 规则和历史明确登记的 `legacy-v1` 抑制指纹可兼容匹配；未知版本或缺失 key id 只报告 `blockedRules`，不静默放行。恢复副本必须先导入备份时点之后产生的删除/抑制规则；旧 UUID 只作为历史审计，不能自行识别新 UUID；规则不会保存原始联系人作为黑名单。

```bash
pnpm retention:replay -- --dry-run
RETENTION_MAINTENANCE_CONFIRM=1 RETENTION_MAINTENANCE_ACTOR_ID="$ACTOR_ID" \
  pnpm retention:replay -- --batch-size 100 --max-batches 100
```

重放是幂等的：已经删除的记录不会再次产生变化；`LEGACY_UNKNOWN` 规则只计数并报告，不猜测恢复对象。当前没有部署生产恢复调度，CLI 仅允许隔离 `demo`/`test` 数据库运行。

## 跨服务锁序

下载、导出创建、手动删除、联系人到期清理、抑制、提取和审核遵循同一资源顺序：`Source → suppression/identity fingerprint → Account → ContactPoint → Evidence → AccountLink pair → ExportJob`。事务先读取候选集合，再按稳定排序加锁并重新读取；可重试冲突只允许有限整事务重试，失败事务不会继续查询。该锁序不保证外部已经下载的 CSV 可被回收。

## 日志和 token

导出 token 只在创建响应中返回一次，数据库只保存哈希；审计事件不保存 token、联系原值、Evidence 原文或 CSV。反向代理和应用访问日志必须对 `/api/exports/*/download?token=...` 做 query 参数脱敏（至少将 `token` 替换为 `[REDACTED]`），并不得在错误追踪中记录完整 URL。该配置尚未随本仓库部署到具体代理，部署前必须完成核验。

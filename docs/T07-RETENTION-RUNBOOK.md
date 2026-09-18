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

账号删除规则保存限定范围、算法版本、期限和 HMAC key id 的稳定平台身份指纹。重放时，旧 UUID 只作为历史审计，不能自行识别新 UUID；只有仍在期限内且具有版本化稳定身份指纹的规则才匹配新记录。抑制规则通过兼容的 HMAC 候选匹配恢复库中的联系人，不保存原始联系人作为黑名单。

```bash
pnpm retention:replay -- --dry-run
RETENTION_MAINTENANCE_CONFIRM=1 RETENTION_MAINTENANCE_ACTOR_ID="$ACTOR_ID" \
  pnpm retention:replay
```

重放是幂等的：已经删除的记录不会再次产生变化；`LEGACY_UNKNOWN` 规则只计数并报告，不猜测恢复对象。

## 日志和 token

导出 token 只在创建响应中返回一次，数据库只保存哈希；审计事件不保存 token、联系原值、Evidence 原文或 CSV。反向代理和应用访问日志必须对 `/api/exports/*/download?token=...` 做 query 参数脱敏（至少将 `token` 替换为 `[REDACTED]`），并不得在错误追踪中记录完整 URL。该配置尚未随本仓库部署到具体代理，部署前必须完成核验。

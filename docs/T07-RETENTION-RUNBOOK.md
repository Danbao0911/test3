# T07 生命周期维护运行说明

## R2 复核更新

维护命令现在输出 `scanComplete`、`previewComplete`、`enforcementComplete`、`executionComplete` 和 `complete`。dry-run 的 `enforcementComplete` 固定为 `null`，只表示扫描预览，不表示已删除；扫描结束但存在未知规则、缺失 key、未知算法、未知 scope 或不完整指纹时，正式 `replay` 不能作为恢复完成并返回退出码 3；达到 `--max-batches` 且仍有游标时返回退出码 2。正常完成和只读 dry-run 返回退出码 0。

`--checkpoint` 使用 v2 HMAC 凭据，绑定操作类型、`dry-run`/`execute` 模式、数据库名称、非敏感的目标指纹、`RETENTION_RUN_ID`/`TEST_RUN_ID` 和截止时间。旧 v1 token、篡改 token、错操作、错模式、错运行标识或错隔离目标都会在数据库写入前拒绝；dry-run 续跑 token 不能交给 execute，必须以全新 execute 从头开始。目标指纹只包含协议/主机/端口/数据库和运行标识的 hash，不含密码或完整 URL。命令输出的 `continuation` 可直接传给同模式的新进程；不得手工修改其中的游标。服务端配置 `RETENTION_CHECKPOINT_KEY`，没有该配置时仅允许隔离非生产模式使用测试派生值。

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
RETENTION_RUN_ID="restore-2026-09-18" RETENTION_MAINTENANCE_CONFIRM=1 RETENTION_MAINTENANCE_ACTOR_ID="$ACTOR_ID" \
  pnpm retention:cleanup -- --batch-size 50 --max-batches 100

# 上次输出 incomplete 且有 continuation 时，使用同一 RETENTION_RUN_ID 续跑
RETENTION_RUN_ID="restore-2026-09-18" RETENTION_MAINTENANCE_CONFIRM=1 RETENTION_MAINTENANCE_ACTOR_ID="$ACTOR_ID" \
  pnpm retention:cleanup -- --batch-size 50 --max-batches 100 --checkpoint "$CHECKPOINT"
```

联系到期与手动删除共用依赖清理：先清除受影响的临时导出，再把 `AccountLinkEvidence.referenceEvidenceMissing` 标为 true，最后删除 Evidence（级联删除 ContactPoint）。清理不会用外键 `SET NULL` 推断“原本没有引用”。

## 恢复规则重放

账号删除规则分别保存“平台 + 稳定 ID”和“平台 + 规范主页”的独立指纹、限定范围、算法版本、期限和 HMAC key id。任一仍有效的规则命中都会阻止恢复；不要求两个身份同时出现，也不使用昵称、头像或跨平台同名推断。单条录入、CSV 导入和恢复重放共用同一身份规则服务。旧复合指纹无法拆回原始身份，追加迁移将其标记为 `LEGACY_UNKNOWN`，不伪造新指纹。

重放对账号和联系人使用独立的稳定 ID 游标。每次返回 `scanned`、`matched`、`deleted`、`hasMore` 和 `next.accountCursor`/`next.contactCursor`，并额外返回各范围的 `accountDone`/`contactDone`，因此首批零命中不会提前结束，也不会在另一范围仍有数据时重扫已完成范围。`--max-batches` 到达上限时输出 `incomplete: true`、续跑游标并以退出码 2 结束；只有两个范围都完成才输出 `complete: true`。

重放和在线路径均按算法版本和 key id 选择规则：当前 v2 规则、配置映射中的历史 v2 key，以及具有真实旧 key 映射的 `legacy-v1` 抑制指纹可兼容匹配；v2 旧 key 不会被当作 v1，URL/opaque ID 不会无依据小写化。生产环境应通过 `SUPPRESSION_HMAC_KEY_ID`、`SUPPRESSION_HMAC_KEY` 和受控的 `SUPPRESSION_HMAC_KEYS_JSON` 提供真实 key 映射；恢复缺少旧 key、未知版本、未知 scope、空指纹或不完整身份字段只报告 `blockedRules`，在线录入遇到无法核验的身份删除规则会明确阻断，不静默放行，也不把当前 key 冒充旧 key。恢复副本必须先导入备份时点之后产生的删除/抑制规则；旧 UUID 只作为历史审计，不能自行识别新 UUID；规则不会保存原始联系人作为黑名单。

```bash
pnpm retention:replay -- --dry-run
RETENTION_RUN_ID="restore-2026-09-18" RETENTION_MAINTENANCE_CONFIRM=1 RETENTION_MAINTENANCE_ACTOR_ID="$ACTOR_ID" \
  pnpm retention:replay -- --batch-size 100 --max-batches 100
```

重放是幂等的：已经删除的记录不会再次产生变化；`LEGACY_UNKNOWN` 规则只计数并报告，不猜测恢复对象。恢复过程中发现阻塞可以执行已验证规则，但最终 `enforcementComplete` 必须为 false，直到补齐可信规则/密钥后重新运行。当前没有部署生产恢复调度，CLI 仅允许隔离 `demo`/`test` 数据库运行。

## 跨服务锁序

下载、导出创建、手动删除、联系人到期清理、抑制、提取和审核遵循同一资源顺序：`Source → suppression/identity fingerprint → Account → ContactPoint → Evidence → AccountLink pair → ExportJob`。账号导入、账号删除和恢复账号删除使用同一平台 nativeId/profile advisory lock 键；事务先读取候选集合，再按稳定排序加锁并重新读取；可重试冲突只允许有限整事务重试，失败事务不会继续查询。该锁序不保证外部已经下载到的 CSV 可被回收。

## 日志和 token

导出 token 只在创建响应中返回一次，数据库只保存哈希；审计事件不保存 token、联系原值、Evidence 原文或 CSV。反向代理和应用访问日志必须对 `/api/exports/*/download?token=...` 做 query 参数脱敏（至少将 `token` 替换为 `[REDACTED]`），并不得在错误追踪中记录完整 URL。该配置尚未随本仓库部署到具体代理，部署前必须完成核验。

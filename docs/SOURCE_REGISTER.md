# 平台能力与许可登记

核查日期：2026-09-18。文档核查执行：Codex；项目应用负责人、审批人尚未登记。本次仅访问官方文档，没有调用平台数据 API。T08 保持关闭态；本次追加 T09 的小红书/抖音能力核验，但没有获得项目应用授权，也没有开启真实接入。

`/platforms` 和 `GET /api/platforms` 展示的是项目实现状态。官方提供接口不代表本应用取得权限，添加环境变量或批准人工来源也不会开启平台调用。当前请求预算硬关闭为 0，自动重试为 0；没有产生平台费用，不把 0 当成厂商实际配额。

## 项目能力矩阵

| 平台 | 关键词发现 / 资料读取 | 刷新 / 平台删除同步 | 真实调用 | 当前可用通路 |
| --- | --- | --- | --- | --- |
| YouTube | 未配置、未验证 | 尚不支持 | 未执行 | 获准人工来源录入；隔离演示库使用合成资料 |
| X | 未配置、未验证 | 尚不支持 | 未执行 | 同上；人工来源不自动获得站外关联许可 |
| 小红书 | 仅核验到主动授权用户的 `basic_info`；项目未配置 | 尚不支持 | 未执行 | 获准人工来源录入；不能据此发现任意账号或第三人联系方式 |
| 抖音 | 仅核验到带 `user_info` scope、`access_token` 和 `open_id` 的授权用户公开资料；项目未配置 | 尚不支持 | 未执行 | 获准人工来源录入；不能据此发现任意账号或第三人联系方式 |

本地删除功能不等于接收或执行平台删除同步。平台适配器的 `handleDeletion` 返回 `not_supported`，不会谎报清理完成。本轮不新增 T09 的官方调用实现。

## YouTube 登记项

| 项目 | 本次已核查 / 项目状态 |
| --- | --- |
| 官方资料端点 | 文档列出 `GET https://www.googleapis.com/youtube/v3/channels`，可按频道 ID 或 handle 查询。[channels.list](https://developers.google.com/youtube/v3/docs/channels/list) |
| 发现端点 | 文档列出 `GET https://www.googleapis.com/youtube/v3/search`，支持类型筛选及分页。本项目尚未实现调用。[search.list](https://developers.google.com/youtube/v3/docs/search/list) |
| 字段 | `channel` 的 `id`、`snippet.title` 等是资料字段；资源定义没有通用商务邮箱字段。本项目尚未批准任何 API 获取字段。[channel resource](https://developers.google.com/youtube/v3/docs/channels) |
| 应用 / 凭据所有者 / scope / 账号范围 | 全部待项目负责人登记与核验；未提供或保存凭据 |
| 本项目允许用途 | 官方 API 获取、联系提取、关联、导出、外部模型处理均未获准 |
| 费用 / 配额 | 文档计量需与项目控制台实际配额再次核对；当前应用费用、每日上限及单位消耗未验证，不硬编码文档数字为本应用额度 |
| 刷新 / 保留 / 撤权 | 官方政策区分授权/非授权数据、刷新删除、撤回授权和用户删除请求，不能统一用永久保存或一个天数覆盖。逐字段 deadline、撤权检查及运行任务仍待核验。[Developer Policies III.E](https://developers.google.com/youtube/terms/developer-policies) |
| 最小真实调用 | 未执行；测试时间、HTTP 状态、返回字段、消耗配额和脱敏响应样例均为空，不复制文档样例充当实测 |

## X 登记项

| 项目 | 本次已核查 / 项目状态 |
| --- | --- |
| 官方资料端点 | 官方文档列出 `/2/users/:id`、`/2/users/by/username/:username` 等用户查询及应用访问前提。本项目未调用。[User Lookup](https://docs.x.com/x-api/users/lookup/introduction) |
| 发现能力 | 用户查询不等于已获准的关键词发现；本应用可用的发现端点与允许查询范围待验证 |
| 字段 / 应用 / scope / 账号范围 | 当前均未批准；拟验证的稳定 ID、显示名等最小字段仍需逐项审批，不保存文档响应为真实记录 |
| 允许用途 / 站外关联 | Off-X matching 受独立政策条件限制；本项目不根据共同邮箱、昵称或头像自动建立关联。[Developer Policy](https://docs.x.com/developer-terms/policy) |
| 保留 / 变更 / 删除 | 平台内容变更与删除同步须单独落实，责任人、触发机制、执行期限和演练证据待核验；人工录入授权不替代该流程 |
| 费用 / 配额 / 限流 | 应用套餐与费用上限未核验。官方说明 429 与 reset 信息，且请求限流与计费不同；不得轮换应用/密钥绕过限制。[Rate limits](https://docs.x.com/x-api/fundamentals/rate-limits) |
| 最小真实调用 | 未执行；应用标识、时间、HTTP 结果、脱敏字段样例与配额消耗均待记录 |

## 小红书与抖音登记项（T09）

| 项目 | 小红书 | 抖音 |
| --- | --- | --- |
| 官方能力 | 账号开放平台以 OAuth 2.0 授权为主；当前公开 scope `basic_info` 返回昵称、头像、性别、地区等基本资料。[官方 scope](https://openaccount.xiaohongshu.com/docs/scope) [API 参考](https://openaccount.xiaohongshu.com/docs/api-reference) | `POST https://open.douyin.com/oauth/userinfo/` 需要 `user_info` scope、`access_token` 和 `open_id`，返回授权用户公开信息。[获取用户公开信息](https://partner.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/get-account-open-info) |
| 主体/授权边界 | 用户主动授权后才能获取该用户在本应用下的资料；文档没有证明任意账号关键词发现或第三人商务联系方式查询 | 文档描述的是授权用户信息，不等于任意账号搜索；用户唯一标识和 token 由授权流程提供 |
| 本项目状态 | `AUTHORIZED_SUBJECT_ONLY`、`not_supported`、`verifiedAt=null`、请求预算 0；没有 app_id/app_secret、scope 或真实调用记录 | `AUTHORIZED_SUBJECT_ONLY`、`not_supported`、`verifiedAt=null`、请求预算 0；没有 app_id/access_token/open_id 或真实调用记录 |
| 允许路径 | 继续使用获准人工来源录入；未来如取得主体授权，只能单独建立授权用户流程并重新核验字段用途 | 继续使用获准人工来源录入；未来如取得主体授权，只能按授权主体范围建立流程并重新核验字段用途 |
| 未实现能力 | 任意账号发现、关键词检索、第三人联系提取、平台删除同步 | 任意账号发现、关键词检索、第三人联系提取、平台删除同步 |

本次核验没有把官方文档示例当成项目实测，也没有进行最小真实调用。两平台统一适配器仍明确返回 `not_supported`，不会返回虚构账号、空数组成功或伪造授权。项目 UI 会把两平台显示为“仅主动授权主体资料”，同时保留“外部搜索未开放”提示。

## 本地预检与后续开放条件

管理员选择已有来源、平台和能力后，`POST /api/platforms/preflight` 在来源共享行锁内读取当前版本及对应快照。撤销、到期、缺失/legacy 快照会列入阻塞项，旧表单返回 `SOURCE_POLICY_CONFLICT`/409；没有自动换版本重试。接口仅接收四个字段，拒绝凭据、任意 URL、客户端 role、scope 和“已验证”标志。

预检返回 200 只表示本地核对完成；正文明确 `executed=false`、`outboundRequests=0`、`advisoryOnly=true`，不会发放可执行授权。真实运行以后必须再次检查角色、平台专项许可、当前来源版本、字段、预算、生命周期和撤权，不能重放预检结果。

后续负责人需在受限的项目运行记录中登记应用别名/负责人、精确端点、授权方式及 scope、主体/账号范围、获准字段与用途、到期和删除时限、费用/配额上限及审批人。不得在公开仓库或聊天粘贴密钥、Cookie、完整响应或个人联系方式。T07 恢复与运行验收仍为真实数据前置阻塞。

获得这些条件后才能实施真实 transport、最小调用、分页和重试。届时记录真实测试时间、应用别名、请求字段、HTTP 状态、配额变化、脱敏响应摘要及审批关联。`ConnectorResult` 已区分 `success`、`empty`、`not_configured`、`permission_required`、`not_supported`、`rate_limited`、`quota_exhausted`、`failed`；其中真实空结果、限流及配额耗尽处理本轮仅定义协议，没有伪造平台响应测试或声称上线。

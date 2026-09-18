import { platformIds, type DisabledResult, type PlatformAdapter, type PlatformCapabilities, type PlatformId, type PlatformOperation } from "./types";

const definitions: Record<PlatformId, { label: string; research: boolean; accessPath: PlatformCapabilities["accessPath"]; limitation: string }> = {
  YOUTUBE: { label: "YouTube", research: true, accessPath: "PROJECT_APP_PENDING", limitation: "尚无项目应用的真实调用记录。频道资料读取不包含通用商务邮箱授权；提取、关联和导出需独立许可。" },
  X: { label: "X", research: true, accessPath: "PROJECT_APP_PENDING", limitation: "尚无项目应用的真实调用记录。读取资料不授予站外关联权限，须核验用途、字段及删除同步。" },
  XIAOHONGSHU: { label: "小红书", research: false, accessPath: "AUTHORIZED_SUBJECT_ONLY", limitation: "官方资料当前核验到的是用户主动授权后的基本信息（basic_info）；本项目没有应用审核、授权用户或任意账号发现权限，不能把它显示为已接入。" },
  DOUYIN: { label: "抖音", research: false, accessPath: "AUTHORIZED_SUBJECT_ONLY", limitation: "官方资料当前核验到的是 user_info 授权用户的公开资料；本项目没有应用授权或第三人任意账号发现权限，不能把它显示为已接入。" },
};

function disabled(platform: PlatformId, operation: PlatformOperation): DisabledResult {
  const research = definitions[platform].research;
  return {
    status: research && (operation === "discoverAccounts" || operation === "fetchProfile") ? "not_configured" : "not_supported",
    code: research && (operation === "discoverAccounts" || operation === "fetchProfile") ? "APPLICATION_NOT_VERIFIED" : "OPERATION_NOT_IMPLEMENTED",
    message: operation === "handleDeletion"
      ? "平台删除同步尚未实现；本地删除请使用现有删除流程。"
      : research ? "尚未完成应用授权、最小真实调用与生命周期验收，当前不能执行平台请求。" : "此平台操作尚未实现，不能执行平台请求。",
    executed: false,
    outboundRequests: 0,
  };
}

/** No transport, credentials, user URLs or fixtures are accepted by these adapters.
 * Registering/approving a manual source cannot activate a platform transport.
 */
export function getPlatformAdapter(platform: PlatformId): PlatformAdapter {
  const definition = definitions[platform];
  return {
    capabilities: () => ({
      platform, label: definition.label, accessPath: definition.accessPath, state: definition.research ? "unconfigured" : "not_supported",
      verifiedAt: null, externalRequestsEnabled: false,
      requestBudget: { maxRequests: 0, automaticRetries: 0, vendorQuota: null },
      operations: {
        discoverAccounts: disabled(platform, "discoverAccounts"), fetchProfile: disabled(platform, "fetchProfile"),
        refreshRecord: disabled(platform, "refreshRecord"), handleDeletion: disabled(platform, "handleDeletion"),
      },
      limitation: definition.limitation,
    }),
    discoverAccounts: async () => disabled(platform, "discoverAccounts"),
    fetchProfile: async () => disabled(platform, "fetchProfile"),
    refreshRecord: async () => disabled(platform, "refreshRecord"),
    handleDeletion: async () => disabled(platform, "handleDeletion"),
  };
}

export function platformCapabilityList(): PlatformCapabilities[] {
  return platformIds.map(platform => getPlatformAdapter(platform).capabilities());
}

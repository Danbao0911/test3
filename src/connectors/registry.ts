import { platformIds, type DisabledResult, type PlatformAdapter, type PlatformCapabilities, type PlatformId, type PlatformOperation } from "./types";

const definitions: Record<PlatformId, { label: string; research: boolean; limitation: string }> = {
  YOUTUBE: { label: "YouTube", research: true, limitation: "尚无项目应用的真实调用记录。频道资料读取不包含通用商务邮箱授权；提取、关联和导出需独立许可。" },
  X: { label: "X", research: true, limitation: "尚无项目应用的真实调用记录。读取资料不授予站外关联权限，须核验用途、字段及删除同步。" },
  XIAOHONGSHU: { label: "小红书", research: false, limitation: "本项目尚不支持官方自动发现或资料读取；任意账号发现权限待 T09 核验。" },
  DOUYIN: { label: "抖音", research: false, limitation: "本项目尚不支持官方自动发现或资料读取；主体授权不代表允许检索第三人资料。" },
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
      platform, label: definition.label, state: definition.research ? "unconfigured" : "not_supported",
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

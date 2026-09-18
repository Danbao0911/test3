export const platformIds = ["YOUTUBE", "X", "XIAOHONGSHU", "DOUYIN"] as const;
export type PlatformId = typeof platformIds[number];
export const platformOperations = ["discoverAccounts", "fetchProfile", "refreshRecord", "handleDeletion"] as const;
export type PlatformOperation = typeof platformOperations[number];

// A future transport must distinguish an actual empty response from a denial.
// The current adapters implement only DisabledResult and cannot produce success.
export type ConnectorResult<T> =
  | { status: "success"; data: T }
  | { status: "empty" }
  | DisabledResult
  | { status: "rate_limited"; retryAfterSeconds: number | null }
  | { status: "quota_exhausted"; resetAt: string | null }
  | { status: "failed"; code: string };

export type DisabledResult = {
  status: "not_configured" | "permission_required" | "not_supported";
  code: "APPLICATION_NOT_VERIFIED" | "OPERATION_NOT_IMPLEMENTED";
  message: string;
  executed: false;
  outboundRequests: 0;
};

export type PlatformCapabilities = {
  platform: PlatformId;
  label: string;
  state: "unconfigured" | "not_supported";
  verifiedAt: null;
  externalRequestsEnabled: false;
  // This is a local hard stop, not an assertion about the vendor's quota.
  requestBudget: { maxRequests: 0; automaticRetries: 0; vendorQuota: null };
  operations: Record<PlatformOperation, DisabledResult>;
  limitation: string;
};

export interface PlatformAdapter {
  capabilities(): PlatformCapabilities;
  discoverAccounts(): Promise<DisabledResult>;
  fetchProfile(): Promise<DisabledResult>;
  refreshRecord(): Promise<DisabledResult>;
  handleDeletion(): Promise<DisabledResult>;
}

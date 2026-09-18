import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { ACCOUNT_IDENTITY_FINGERPRINT_VERSION, SUPPRESSION_FINGERPRINT_KEY_ID, configuredSuppressionKeyIds, stableIdentityFingerprintsForKey, suppressionKeyAvailable } from "./data-protection";

function identityLockKey(kind: "native" | "profile", platform: string, value: string) {
  const digest = createHash("sha256").update(`${kind}\0${platform.trim().toUpperCase()}\0${value.trim()}`).digest("hex");
  return `test3:account-identity:${digest}`;
}

/** Shared by account import, deletion and restore replay. */
export function accountIdentityLockKeys(input: { platform: string; nativeId?: string | null; normalizedProfileUrl: string }) {
  return [
    identityLockKey("profile", input.platform, input.normalizedProfileUrl),
    ...(input.nativeId?.trim() ? [identityLockKey("native", input.platform, input.nativeId)] : []),
  ];
}

export function activeDeletionIdentityWhere(input: { platform: string; nativeId?: string | null; normalizedProfileUrl: string }, now = new Date()): Prisma.DeletionRequestWhereInput {
  const identities = configuredSuppressionKeyIds()
    .filter((keyId) => suppressionKeyAvailable(keyId))
    .map((keyId) => stableIdentityFingerprintsForKey(input, keyId));
  return {
    scope: "ACCOUNT_REIMPORT_BLOCK",
    identityVersion: ACCOUNT_IDENTITY_FINGERPRINT_VERSION,
    OR: [
      ...identities.flatMap((identity) => [
        ...(identity.nativeId ? [{ identityNativeFingerprint: identity.nativeId }] : []),
        { identityProfileFingerprint: identity.profileUrl },
      ]),
    ],
    AND: [{ OR: [{ identityExpiresAt: null }, { identityExpiresAt: { gt: now } }] }],
  };
}

export function deletionRuleMatchesAccount(account: { platform: string; nativeId?: string | null; normalizedProfileUrl: string }, rule: { identityNativeFingerprint: string | null; identityProfileFingerprint: string | null; identityKeyId?: string | null }) {
  if (!rule.identityKeyId || !suppressionKeyAvailable(rule.identityKeyId)) return false;
  const identities = stableIdentityFingerprintsForKey(account, rule.identityKeyId ?? SUPPRESSION_FINGERPRINT_KEY_ID);
  return Boolean((identities.nativeId && rule.identityNativeFingerprint === identities.nativeId) || rule.identityProfileFingerprint === identities.profileUrl);
}

export function deletionRuleIsSupported(rule: { identityType?: string | null; identityVersion?: number | null; identityKeyId?: string | null; identityNativeFingerprint?: string | null; identityProfileFingerprint?: string | null; scope?: string | null; targetType?: string | null }) {
  return rule.targetType === "ACCOUNT" && rule.scope === "ACCOUNT_REIMPORT_BLOCK" &&
    rule.identityType === "ACCOUNT_PLATFORM_IDENTITY_V2" && rule.identityVersion === ACCOUNT_IDENTITY_FINGERPRINT_VERSION &&
    Boolean(rule.identityKeyId && suppressionKeyAvailable(rule.identityKeyId)) &&
    Boolean(rule.identityNativeFingerprint || rule.identityProfileFingerprint);
}

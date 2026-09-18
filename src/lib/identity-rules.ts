import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { ACCOUNT_IDENTITY_FINGERPRINT_VERSION, SUPPRESSION_FINGERPRINT_KEY_ID, stableIdentityFingerprints, stableIdentityFingerprintsForKey } from "./data-protection";

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
  const identities = stableIdentityFingerprints(input);
  return {
    scope: "ACCOUNT_REIMPORT_BLOCK",
    identityVersion: ACCOUNT_IDENTITY_FINGERPRINT_VERSION,
    OR: [
      ...(identities.nativeId ? [{ identityNativeFingerprint: identities.nativeId }] : []),
      { identityProfileFingerprint: identities.profileUrl },
    ],
    AND: [{ OR: [{ identityExpiresAt: null }, { identityExpiresAt: { gt: now } }] }],
  };
}

export function deletionRuleMatchesAccount(account: { platform: string; nativeId?: string | null; normalizedProfileUrl: string }, rule: { identityNativeFingerprint: string | null; identityProfileFingerprint: string | null; identityKeyId?: string | null }) {
  const identities = stableIdentityFingerprintsForKey(account, rule.identityKeyId ?? SUPPRESSION_FINGERPRINT_KEY_ID);
  return Boolean((identities.nativeId && rule.identityNativeFingerprint === identities.nativeId) || rule.identityProfileFingerprint === identities.profileUrl);
}

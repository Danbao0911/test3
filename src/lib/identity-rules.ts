import type { Prisma } from "@/generated/prisma/client";
import { ACCOUNT_IDENTITY_FINGERPRINT_VERSION, stableIdentityFingerprints } from "./data-protection";

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

export function deletionRuleMatchesAccount(account: { platform: string; nativeId?: string | null; normalizedProfileUrl: string }, rule: { identityNativeFingerprint: string | null; identityProfileFingerprint: string | null }) {
  const identities = stableIdentityFingerprints(account);
  return Boolean((identities.nativeId && rule.identityNativeFingerprint === identities.nativeId) || rule.identityProfileFingerprint === identities.profileUrl);
}

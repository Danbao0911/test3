import { randomUUID, createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { parseTestDatabaseConfig, assertRestrictedTestRole } from "../helpers/test-database";
import { replayDeletionRules } from "../../src/lib/retention-service";
import { legacySuppressionFingerprint, stableIdentityFingerprints, suppressionFingerprint, SUPPRESSION_FINGERPRINT_KEY_ID, SUPPRESSION_FINGERPRINT_VERSION } from "../../src/lib/data-protection";

const database = parseTestDatabaseConfig();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: database.url }) });
let databaseReady = false;
let actorId = "";
let sourceId = "";
let snapshotId = "";
const accountIds: string[] = [];
const evidenceIds: string[] = [];
const contactIds: string[] = [];

function orderedUuid(group: number, index: number) {
  return `00000000-0000-4000-8000-${String(group * 1_000 + index).padStart(12, "0")}`;
}

describe("CODEX-002-LATEST-REVIEW real PostgreSQL replay and identity rules", () => {
  beforeAll(async () => {
    const guard = new pg.Client({ connectionString: database.url });
    try { await guard.connect(); await assertRestrictedTestRole(guard, database.databaseName); databaseReady = true; }
    finally { await guard.end(); }
    const actor = await prisma.user.create({ data: { email: `latest-review-${database.runId}-${randomUUID()}@example.test`, passwordHash: await bcrypt.hash("latest-review", 4), role: "ADMIN" } });
    actorId = actor.id;
    const source = await prisma.source.create({ data: { name: `LATEST 来源 ${randomUUID()}`, type: "DEMO", status: "APPROVED", permissionNote: "LATEST 隔离测试授权", allowImport: true, allowExtract: true, allowEvidenceText: true, allowExport: true, policyVersion: 1, retentionDays: 30 } });
    sourceId = source.id;
    const snapshot = await prisma.sourcePolicySnapshot.create({ data: { sourceId, version: 1, status: "APPROVED", allowImport: true, allowExtract: true, allowEvidenceText: true, allowExport: true, authorizationBasis: "LATEST 隔离测试授权", changeType: "TEST" } });
    snapshotId = snapshot.id;
  }, 30_000);

  afterAll(async () => {
    if (!databaseReady) { await prisma.$disconnect(); return; }
    if (actorId) {
      await prisma.contactSuppression.deleteMany({ where: { createdById: actorId } });
      await prisma.deletionRequest.deleteMany({ where: { requestedById: actorId } });
      await prisma.auditEvent.deleteMany({ where: { actorId } });
      await prisma.session.deleteMany({ where: { userId: actorId } });
    }
    if (contactIds.length) await prisma.contactPoint.deleteMany({ where: { id: { in: contactIds } } });
    if (evidenceIds.length) await prisma.evidence.deleteMany({ where: { id: { in: evidenceIds } } });
    if (accountIds.length) await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    if (snapshotId) await prisma.sourcePolicySnapshot.deleteMany({ where: { id: snapshotId } });
    if (sourceId) await prisma.source.deleteMany({ where: { id: sourceId } });
    if (actorId) await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  }, 30_000);

  it("扫描 205+205 全范围，跨批恢复、重复重放和旧指纹兼容均可验证", async () => {
    const firstAccounts = Array.from({ length: 205 }, (_, index) => ({ id: orderedUuid(1, index), platform: "X" as const, nativeId: `latest-account-${index}`, displayName: `LATEST account ${index}`, profileUrl: `https://example.com/latest/account/${index}`, normalizedProfileUrl: `https://example.com/latest/account/${index}`, organization: "LATEST", serviceTags: ["test"], region: "上海", sourceId, sourceUrl: "https://example.com/latest/source", capturedAt: new Date(), isDemo: true }));
    const secondAccounts = Array.from({ length: 205 }, (_, index) => ({ id: orderedUuid(2, index), platform: "X" as const, nativeId: `latest-contact-account-${index}`, displayName: `LATEST contact account ${index}`, profileUrl: `https://example.com/latest/contact-account/${index}`, normalizedProfileUrl: `https://example.com/latest/contact-account/${index}`, organization: "LATEST", serviceTags: ["test"], region: "上海", sourceId, sourceUrl: "https://example.com/latest/source", capturedAt: new Date(), isDemo: true }));
    const accounts = await prisma.account.createManyAndReturn({ data: [...firstAccounts, ...secondAccounts] });
    accountIds.push(...accounts.map((account) => account.id));
    for (const index of [100, 204]) {
      const identity = stableIdentityFingerprints(firstAccounts[index]!);
      await prisma.deletionRequest.create({ data: { targetHash: createHash("sha256").update(`latest-account-${index}`).digest("hex"), targetType: "ACCOUNT", accountId: firstAccounts[index]!.id, identityNativeFingerprint: identity.nativeId, identityProfileFingerprint: identity.profileUrl, identityType: "ACCOUNT_PLATFORM_IDENTITY_V2", identityVersion: 2, identityKeyId: SUPPRESSION_FINGERPRINT_KEY_ID, scope: "ACCOUNT_REIMPORT_BLOCK", identityExpiresAt: new Date(Date.now() + 86_400_000), reason: "LATEST replay test", requestedById: actorId, completedById: actorId } });
    }

    const evidenceRows = Array.from({ length: 205 }, (_, index) => ({ id: orderedUuid(3, index), accountId: secondAccounts[index]!.id, sourceId, policyVersion: 1, policySnapshotId: snapshotId, sourceUrl: "https://example.com/latest/evidence", capturedAt: new Date(), fieldLocation: `row-${index}`, excerpt: `latest-${index}@example.com` }));
    const contactRows = evidenceRows.map((evidence, index) => ({ id: orderedUuid(4, index), evidenceId: evidence.id, dedupeKey: createHash("sha256").update(evidence.id).digest("hex"), type: "EMAIL" as const, rawValue: `latest-${index}@example.com`, normalizedValue: `latest-${index}@example.com`, status: "APPROVED" as const, ownershipConfirmed: true, businessConfirmed: true, version: 1, expiresAt: new Date(Date.now() + 86_400_000), reviewedAt: new Date() }));
    await prisma.evidence.createMany({ data: evidenceRows });
    await prisma.contactPoint.createMany({ data: contactRows });
    evidenceIds.push(...evidenceRows.map((row) => row.id)); contactIds.push(...contactRows.map((row) => row.id));
    for (const index of [100, 204]) {
      await prisma.contactSuppression.create({ data: { fingerprint: suppressionFingerprint("EMAIL", contactRows[index]!.normalizedValue), fingerprintVersion: SUPPRESSION_FINGERPRINT_VERSION, fingerprintKeyId: SUPPRESSION_FINGERPRINT_KEY_ID, scope: "CONTACT_VALUE_GLOBAL", contactType: "EMAIL", contactId: contactRows[index]!.id, accountId: secondAccounts[index]!.id, reasonCode: "DO_NOT_CONTACT", basis: "LATEST replay test", expiresAt: new Date(Date.now() + 86_400_000), createdById: actorId } });
    }
    await prisma.contactSuppression.create({ data: { fingerprint: legacySuppressionFingerprint("EMAIL", contactRows[50]!.normalizedValue), fingerprintVersion: 1, fingerprintKeyId: "legacy-v1", scope: "CONTACT_VALUE_GLOBAL", contactType: "EMAIL", contactId: contactRows[50]!.id, accountId: secondAccounts[50]!.id, reasonCode: "DO_NOT_CONTACT", basis: "LATEST legacy replay test", expiresAt: new Date(Date.now() + 86_400_000), createdById: actorId } });
    await prisma.contactSuppression.create({ data: { fingerprint: suppressionFingerprint("EMAIL", contactRows[60]!.normalizedValue), fingerprintVersion: 99, fingerprintKeyId: "missing-key", scope: "CONTACT_VALUE_GLOBAL", contactType: "EMAIL", contactId: contactRows[60]!.id, accountId: secondAccounts[60]!.id, reasonCode: "DO_NOT_CONTACT", basis: "LATEST blocked replay test", expiresAt: new Date(Date.now() + 86_400_000), createdById: actorId } });

    let accountCursor: string | undefined;
    let contactCursor: string | undefined;
    let accountDone = false;
    let contactDone = false;
    let scannedAccounts = 0;
    let scannedContacts = 0;
    let deletedAccounts = 0;
    let deletedContacts = 0;
    let batches = 0;
    let last: Awaited<ReturnType<typeof replayDeletionRules>> | undefined;
    do {
      last = await replayDeletionRules(prisma, actorId, { batchSize: 100, accountCursor, contactCursor, accountDone, contactDone });
      batches += 1; scannedAccounts += last.scanned.accounts; scannedContacts += last.scanned.contacts; deletedAccounts += last.deleted.accounts; deletedContacts += last.deleted.contacts;
      accountCursor = last.next.accountCursor ?? undefined; contactCursor = last.next.contactCursor ?? undefined;
      accountDone = last.next.accountDone; contactDone = last.next.contactDone;
    } while (last.hasMore);
    expect(batches).toBeGreaterThanOrEqual(3);
    expect(scannedAccounts).toBeGreaterThanOrEqual(408);
    expect(scannedContacts).toBe(205);
    expect(deletedAccounts).toBe(2);
    expect(deletedContacts).toBe(3);
    expect(await prisma.account.findMany({ where: { id: { in: [firstAccounts[100]!.id, firstAccounts[204]!.id] } } })).toHaveLength(0);
    expect(await prisma.contactPoint.findMany({ where: { id: { in: [contactRows[50]!.id, contactRows[100]!.id, contactRows[204]!.id] } } })).toHaveLength(0);
    expect(last.blockedRules).toBeGreaterThanOrEqual(1);

    const replayAgain = await replayDeletionRules(prisma, actorId, { batchSize: 100 });
    expect(replayAgain.deleted).toEqual({ accounts: 0, contacts: 0 });
  }, 120_000);
});

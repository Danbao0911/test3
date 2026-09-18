import type { Prisma } from "@/generated/prisma/client";

/**
 * Shared dependency cleanup. It deliberately keeps link history rows but marks
 * the reference as missing, so SET NULL cannot be mistaken for independence.
 */
export async function clearContactDependencies(tx: Prisma.TransactionClient, contactId: string, evidenceId: string, accountId: string) {
  await tx.exportJob.deleteMany({ where: { accountIds: { has: accountId } } });
  await tx.accountLinkEvidence.updateMany({ where: { referenceEvidenceId: evidenceId }, data: { referenceEvidenceId: null, referenceEvidenceMissing: true } });
  await tx.evidence.delete({ where: { id: evidenceId } });
  return { contactId, evidenceId, accountId };
}

export async function clearAccountDependencies(tx: Prisma.TransactionClient, accountId: string, evidenceIds: string[]) {
  await tx.exportJob.deleteMany({ where: { accountIds: { has: accountId } } });
  if (evidenceIds.length) await tx.accountLinkEvidence.updateMany({ where: { referenceEvidenceId: { in: evidenceIds } }, data: { referenceEvidenceId: null, referenceEvidenceMissing: true } });
  return { accountId, evidenceIds };
}

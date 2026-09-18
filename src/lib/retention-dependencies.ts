import type { Prisma } from "@/generated/prisma/client";
import { lockRows } from "./resource-locks";

/**
 * Shared dependency cleanup. It deliberately keeps link history rows but marks
 * the reference as missing, so SET NULL cannot be mistaken for independence.
 */
export async function clearContactDependencies(tx: Prisma.TransactionClient, contactId: string, evidenceId: string, accountId: string) {
  const exports = await tx.exportJob.findMany({ where: { accountIds: { has: accountId } }, select: { id: true } });
  await lockRows(tx, "ExportJob", exports.map((item) => item.id));
  await tx.exportJob.deleteMany({ where: { accountIds: { has: accountId } } });
  await tx.accountLinkEvidence.updateMany({ where: { referenceEvidenceId: evidenceId }, data: { referenceEvidenceId: null, referenceEvidenceMissing: true } });
  // Delete both sides explicitly. The FK also cascades ContactPoint from
  // Evidence, but the explicit predicates make the physical cleanup contract
  // observable and safe if a legacy database has a different FK action.
  await tx.contactPoint.deleteMany({ where: { id: contactId } });
  await tx.evidence.deleteMany({ where: { id: evidenceId } });
  return { contactId, evidenceId, accountId };
}

export async function clearAccountDependencies(tx: Prisma.TransactionClient, accountId: string, evidenceIds: string[]) {
  const exports = await tx.exportJob.findMany({ where: { accountIds: { has: accountId } }, select: { id: true } });
  await lockRows(tx, "ExportJob", exports.map((item) => item.id));
  await tx.exportJob.deleteMany({ where: { accountIds: { has: accountId } } });
  if (evidenceIds.length) await tx.accountLinkEvidence.updateMany({ where: { referenceEvidenceId: { in: evidenceIds } }, data: { referenceEvidenceId: null, referenceEvidenceMissing: true } });
  return { accountId, evidenceIds };
}

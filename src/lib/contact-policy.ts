export type ContactPolicy = {
  status: string; allowExtract: boolean; allowEvidenceText: boolean;
  permissionNote: string; expiresAt: Date | null; policyVersion: number;
};

export function extractionAllowed(source: ContactPolicy, now = new Date()) {
  return source.status === "APPROVED" && source.allowExtract && source.allowEvidenceText &&
    Boolean(source.permissionNote.trim()) && (!source.expiresAt || source.expiresAt > now);
}

export function contactUsable(contact: { status: string; expiresAt: Date; ownershipConfirmed: boolean; businessConfirmed: boolean; reviewedAt: Date | null; evidence: { policyVersion: number; source: ContactPolicy; policySnapshot?: { isLegacy: boolean } } }, now = new Date()) {
  return contact.status === "APPROVED" && contact.ownershipConfirmed && contact.businessConfirmed &&
    Boolean(contact.reviewedAt) && contact.expiresAt > now && extractionAllowed(contact.evidence.source, now) &&
    contact.evidence.policyVersion === contact.evidence.source.policyVersion &&
    contact.evidence.policySnapshot?.isLegacy !== true;
}

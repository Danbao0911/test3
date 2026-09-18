import { Prisma } from "../generated/prisma/client";
import type { AccountLinkBasis, AccountLinkStatus, PrismaClient } from "../generated/prisma/client";
import { canMaintain, type Role } from "./permissions";
import { normalizeSourceUrl } from "./account-normalizer";
import { sourceTypeAllowed } from "./runtime-config";
import { contactUsable } from "./contact-policy";
import { suppressionFingerprintCandidates } from "./data-protection";

type Db = PrismaClient | Prisma.TransactionClient;

export class AccountLinkError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) {
    super(message);
    this.name = "AccountLinkError";
  }
}

export const accountLinkInclude = {
  leftAccount: { select: { id: true, platform: true, displayName: true, organization: true, isDemo: true } },
  rightAccount: { select: { id: true, platform: true, displayName: true, organization: true, isDemo: true } },
  source: { select: { id: true, name: true, status: true, allowRelate: true, policyVersion: true, expiresAt: true } },
  createdBy: { select: { id: true, email: true } },
  reviewedBy: { select: { id: true, email: true } },
  evidences: { orderBy: { createdAt: "asc" as const }, select: {
    id: true, sourceId: true, policyVersion: true, sourceUrl: true, capturedAt: true,
    fieldLocation: true, summary: true, leftAccountVerified: true, rightAccountVerified: true, createdAt: true,
  } },
  decisions: { orderBy: { round: "asc" as const }, include: { actor: { select: { id: true, email: true } } } },
} satisfies Prisma.AccountLinkInclude;

type AccountLinkRecord = Prisma.AccountLinkGetPayload<{ include: typeof accountLinkInclude }>;
type RelatingSource = { id: string; status: string; allowRelate: boolean; permissionNote: string; expiresAt: Date | null; type: string; policyVersion: number };
type RelatingSnapshot = { id: string; version: number; allowRelate: boolean | null; isLegacy: boolean };
type RelatingSourceState = { source: RelatingSource; snapshot: RelatingSnapshot | null };
type AccountLinkRecordLike = Omit<AccountLinkRecord, "evidences" | "decisions"> & {
  evidences?: AccountLinkRecord["evidences"];
  decisions?: AccountLinkRecord["decisions"];
};

type RelationEvidenceInput = {
  sourceId: string;
  referenceEvidenceId?: string;
  sourceUrl?: string;
  capturedAt: string;
  fieldLocation: string;
  summary: string;
  leftAccountId: string;
  rightAccountId: string;
  leftAccountVerified: boolean;
  rightAccountVerified: boolean;
};

export type AccountLinkCreateInput = {
  leftAccountId: string;
  rightAccountId: string;
  sourceId: string;
  basis: AccountLinkBasis;
  basisContactId?: string;
  matchingContactId?: string;
};

export type AccountLinkReviewInput = {
  expectedVersion: number;
  status: Extract<AccountLinkStatus, "CONFIRMED" | "REVOKED">;
  reason: string;
  evidence?: RelationEvidenceInput[];
};

export type AccountLinkValidity = { usable: boolean; unusableReason: string | null };

const LINK_REVIEW_LIMIT = 50;
const RETRYABLE_TRANSACTION_CODES = new Set(["P2034", "40P01", "40001"]);

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function canonicalAccountPair(leftAccountId: string, rightAccountId: string) {
  if (!isUuid(leftAccountId) || !isUuid(rightAccountId)) throw new AccountLinkError("INVALID_ID", "账号标识格式无效", 422);
  const left = leftAccountId.toLowerCase();
  const right = rightAccountId.toLowerCase();
  if (left === right) throw new AccountLinkError("SAME_ACCOUNT", "不能把账号关联到自身", 422);
  return left < right ? [left, right] as const : [right, left] as const;
}

async function withLinkTransaction<T>(db: PrismaClient, callback: (tx: Prisma.TransactionClient) => Promise<T>) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await db.$transaction(callback);
    } catch (error) {
      const code = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : error instanceof Error && /40P01|40001/.test(error.message) ? error.message.match(/40P01|40001/)?.[0] : undefined;
      if (!code || !RETRYABLE_TRANSACTION_CODES.has(code) || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 20));
    }
  }
  throw new AccountLinkError("DATABASE_ERROR", "账号关联事务失败", 500);
}

async function requireWriter(tx: Prisma.TransactionClient, actorId: string) {
  const actor = await tx.user.findUnique({ where: { id: actorId }, select: { id: true, role: true } });
  if (!actor || !canMaintain(actor.role)) throw new AccountLinkError("FORBIDDEN", "当前角色无账号关联操作权限", 403);
}

function canUseRelatingSource(source: { status: string; allowRelate: boolean; permissionNote: string; expiresAt: Date | null; type: string; policyVersion: number }, snapshot: { version: number; allowRelate: boolean | null; isLegacy: boolean } | null) {
  return source.status === "APPROVED" && source.allowRelate && Boolean(source.permissionNote.trim()) &&
    (!source.expiresAt || source.expiresAt > new Date()) && sourceTypeAllowed(source.type as never) &&
    Boolean(snapshot && !snapshot.isLegacy && snapshot.version === source.policyVersion && snapshot.allowRelate === true);
}

function assertSourceAllowed(state: RelatingSourceState) {
  if (!canUseRelatingSource(state.source, state.snapshot)) throw new AccountLinkError("SOURCE_RELATE_NOT_ALLOWED", "来源当前未批准账号关联，或关联策略已撤销/到期", 403);
}

async function lockSources(tx: Prisma.TransactionClient, sourceIds: string[]) {
  const ids = [...new Set(sourceIds.map((id) => id.toLowerCase()))].sort();
  if (ids.some((id) => !isUuid(id))) throw new AccountLinkError("INVALID_ID", "来源标识格式无效", 422);
  if (!ids.length) return new Map<string, RelatingSourceState>();
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Source" WHERE "id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY "id" FOR UPDATE`);
  const sources = await tx.source.findMany({ where: { id: { in: ids } } });
  if (sources.length !== ids.length) throw new AccountLinkError("SOURCE_NOT_FOUND", "来源不存在", 404);
  const result = new Map<string, RelatingSourceState>();
  for (const source of sources) {
    const snapshot = await tx.sourcePolicySnapshot.findUnique({ where: { sourceId_version: { sourceId: source.id, version: source.policyVersion } } });
    result.set(source.id, { source, snapshot });
  }
  return result;
}

async function lockAccountPairs(tx: Prisma.TransactionClient, pairs: Array<[string, string]>) {
  const canonical = pairs.map(([left, right]) => canonicalAccountPair(left, right));
  const unique = [...new Map(canonical.map((pair) => [`${pair[0]}:${pair[1]}`, pair])).values()].sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`));
  for (const [left, right] of unique) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`test3:account-link:${left}:${right}`}))::text AS locked`;
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Account" WHERE "id" IN (${left}::uuid, ${right}::uuid) ORDER BY "id" FOR UPDATE`);
    const accounts = await tx.account.findMany({ where: { id: { in: [left, right] } }, select: { id: true } });
    if (accounts.length !== 2) throw new AccountLinkError("ACCOUNT_NOT_FOUND", "待关联账号不存在", 404);
  }
}

async function lockContactIds(tx: Prisma.TransactionClient, contactIds: string[]) {
  const ids = [...new Set(contactIds.map((id) => id.toLowerCase()))].sort();
  if (ids.some((id) => !isUuid(id))) throw new AccountLinkError("INVALID_ID", "联系证据标识格式无效", 422);
  if (!ids.length) return;
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ContactPoint" WHERE "id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY "id" FOR UPDATE`);
}

async function validateSharedContactCandidate(tx: Prisma.TransactionClient, sourceState: RelatingSourceState, leftAccountId: string, rightAccountId: string, basisContactId: string, matchingContactId: string) {
  await lockContactIds(tx, [basisContactId, matchingContactId]);
  const contacts = await tx.contactPoint.findMany({ where: { id: { in: [basisContactId, matchingContactId] } }, select: { id: true, type: true, normalizedValue: true, status: true, suppressed: true, expiresAt: true, evidence: { select: { accountId: true, sourceId: true, policyVersion: true, policySnapshot: { select: { isLegacy: true } } } } } });
  const basis = contacts.find((item) => item.id === basisContactId);
  const matching = contacts.find((item) => item.id === matchingContactId);
  if (!basis || !matching) throw new AccountLinkError("CANDIDATE_NOT_FOUND", "共享联系候选证据不存在", 422);
  const accountsMatch = new Set([basis.evidence.accountId, matching.evidence.accountId]);
  if (accountsMatch.size !== 2 || !accountsMatch.has(leftAccountId) || !accountsMatch.has(rightAccountId)) throw new AccountLinkError("CANDIDATE_ACCOUNT_MISMATCH", "共享联系候选与待关联账号不匹配", 422);
  if (basis.type !== matching.type || basis.normalizedValue !== matching.normalizedValue || basis.suppressed || matching.suppressed || basis.status !== "APPROVED" || matching.status !== "APPROVED" || basis.expiresAt <= new Date() || matching.expiresAt <= new Date() || basis.evidence.sourceId !== sourceState.source.id || matching.evidence.sourceId !== sourceState.source.id || basis.evidence.policyVersion !== sourceState.source.policyVersion || matching.evidence.policyVersion !== sourceState.source.policyVersion || basis.evidence.policySnapshot.isLegacy || matching.evidence.policySnapshot.isLegacy) throw new AccountLinkError("LINK_POLICY_STALE", "关联所依据的联系证据或策略已失效，请重新取得并提交证据", 409);
}

async function loadLink(tx: Db, id: string) {
  return tx.accountLink.findUnique({ where: { id }, include: accountLinkInclude });
}

type LinkForValidation = Awaited<ReturnType<typeof loadLink>>;

async function persistRelationEvidence(tx: Prisma.TransactionClient, link: NonNullable<LinkForValidation>, inputs: RelationEvidenceInput[], actorId: string, sourceStates: Map<string, RelatingSourceState>) {
  if (!inputs.length) throw new AccountLinkError("LINK_EVIDENCE_REQUIRED", "确认关联必须提交关系专用证据", 422);
  const [leftId, rightId] = canonicalAccountPair(link.leftAccountId, link.rightAccountId);
  const accounts = await tx.account.findMany({ where: { id: { in: [leftId, rightId] } }, select: { id: true, sourceId: true } });
  for (const input of inputs) {
    const [inputLeft, inputRight] = canonicalAccountPair(input.leftAccountId, input.rightAccountId);
    if (inputLeft !== leftId || inputRight !== rightId) throw new AccountLinkError("LINK_EVIDENCE_ACCOUNT_MISMATCH", "关系证据必须同时指向当前关联的两侧账号", 422);
    const state = sourceStates.get(input.sourceId.toLowerCase());
    if (!state) throw new AccountLinkError("SOURCE_NOT_FOUND", "关系证据来源不存在", 404);
    assertSourceAllowed(state);
    if (!state.snapshot) throw new AccountLinkError("LINK_POLICY_STALE", "关系证据来源缺少当前策略快照", 409);
    let referenceId: string | undefined;
    let referenceSourceUrl: string | undefined;
    if (input.referenceEvidenceId) {
      const reference = await tx.evidence.findUnique({ where: { id: input.referenceEvidenceId }, select: { id: true, sourceId: true, policyVersion: true, sourceUrl: true, accountId: true, contact: { select: { status: true, suppressed: true, expiresAt: true, ownershipConfirmed: true, businessConfirmed: true, reviewedAt: true, type: true, normalizedValue: true, evidence: { select: { policyVersion: true, source: { select: { status: true, allowExtract: true, allowEvidenceText: true, permissionNote: true, expiresAt: true, policyVersion: true } }, policySnapshot: { select: { isLegacy: true } } } } } } } });
      if (!reference) throw new AccountLinkError("LINK_EVIDENCE_REFERENCE_MISSING", "引用的关系证据不存在，不能确认", 409);
      const suppressed = reference.contact ? await tx.contactSuppression.findFirst({ where: { fingerprint: { in: suppressionFingerprintCandidates(reference.contact.type, reference.contact.normalizedValue) }, expiresAt: { gt: new Date() } }, select: { id: true } }) : null;
      if (!reference.contact || !contactUsable(reference.contact, new Date()) || suppressed) throw new AccountLinkError("LINK_DEPENDENCY_STALE", "引用证据对应的联系项已失效或受抑制，不能确认关联", 409);
      if (reference.sourceId !== state.source.id || reference.policyVersion !== state.source.policyVersion || ![leftId, rightId].includes(reference.accountId)) throw new AccountLinkError("LINK_EVIDENCE_REFERENCE_INVALID", "引用证据不属于当前账号对或当前来源策略", 422);
      referenceId = reference.id; referenceSourceUrl = reference.sourceUrl;
    }
    const coverage = await Promise.all(accounts.map(async (account) => {
      if (account.sourceId === state.source.id) return true;
      const matchingEvidence = await tx.evidence.findFirst({ where: { accountId: account.id, sourceId: state.source.id, policyVersion: state.source.policyVersion, policySnapshot: { version: state.source.policyVersion, isLegacy: false } }, select: { id: true } });
      return Boolean(matchingEvidence);
    }));
    if (!coverage.every(Boolean)) throw new AccountLinkError("LINK_EVIDENCE_SCOPE", "关系证据来源未覆盖待关联的两侧账号，不能相互背书", 422);
    let sourceUrl = input.sourceUrl?.trim();
    if (sourceUrl) {
      try { sourceUrl = normalizeSourceUrl(sourceUrl); } catch { throw new AccountLinkError("LINK_EVIDENCE_URL_INVALID", "关系证据地址必须是安全的 HTTPS 链接", 422); }
    } else if (referenceSourceUrl) sourceUrl = referenceSourceUrl;
    if (!sourceUrl) throw new AccountLinkError("LINK_EVIDENCE_REQUIRED", "关系证据必须包含来源地址或已有证据引用", 422);
    const capturedAt = new Date(input.capturedAt);
    if (!Number.isFinite(capturedAt.getTime()) || capturedAt > new Date()) throw new AccountLinkError("LINK_EVIDENCE_TIME_INVALID", "关系证据取得时间无效", 422);
    await tx.accountLinkEvidence.create({ data: { accountLinkId: link.id, sourceId: state.source.id, policyVersion: state.source.policyVersion, policySnapshotId: state.snapshot.id, referenceEvidenceId: referenceId, sourceUrl, capturedAt, fieldLocation: input.fieldLocation.trim(), summary: input.summary.trim(), leftAccountVerified: true, rightAccountVerified: true, createdById: actorId } });
  }
}

async function linkValidity(db: Db, linkId: string): Promise<AccountLinkValidity> {
  const link = await db.accountLink.findUnique({ where: { id: linkId }, include: {
    source: true,
    leftAccount: { select: { id: true, sourceId: true } },
    rightAccount: { select: { id: true, sourceId: true } },
    basisContact: { select: { id: true, status: true, suppressed: true, expiresAt: true, evidence: { select: { sourceId: true, policyVersion: true, policySnapshot: { select: { isLegacy: true } } } } } },
    matchingContact: { select: { id: true, status: true, suppressed: true, expiresAt: true, evidence: { select: { sourceId: true, policyVersion: true, policySnapshot: { select: { isLegacy: true } } } } } },
    evidences: { select: { id: true, sourceId: true, policyVersion: true, policySnapshotId: true, leftAccountVerified: true, rightAccountVerified: true, referenceEvidenceId: true, referenceEvidenceMissing: true } },
  } });
  if (!link) return { usable: false, unusableReason: "LINK_NOT_FOUND" };
  if (link.status === "PENDING") return { usable: false, unusableReason: "PENDING_REVIEW" };
  if (link.status === "REVOKED") return { usable: false, unusableReason: "LINK_REVOKED" };
  const sourceSnapshot = await db.sourcePolicySnapshot.findUnique({ where: { sourceId_version: { sourceId: link.sourceId, version: link.source.policyVersion } } });
  if (link.source.status !== "APPROVED") return { usable: false, unusableReason: "SOURCE_REVOKED" };
  if (!link.source.allowRelate) return { usable: false, unusableReason: "SOURCE_RELATE_DISABLED" };
  if (link.source.expiresAt && link.source.expiresAt <= new Date()) return { usable: false, unusableReason: "SOURCE_EXPIRED" };
  if (link.policyVersion !== link.source.policyVersion) return { usable: false, unusableReason: "LINK_POLICY_STALE" };
  if (!sourceSnapshot || sourceSnapshot.isLegacy || sourceSnapshot.allowRelate !== true) return { usable: false, unusableReason: "LINK_POLICY_STALE" };
  if (!link.evidences.length) return { usable: false, unusableReason: "LINK_EVIDENCE_MISSING" };
  const sourceIds = [...new Set(link.evidences.map((evidence) => evidence.sourceId))];
  const states = await db.source.findMany({ where: { id: { in: sourceIds } }, select: { id: true, status: true, allowRelate: true, permissionNote: true, expiresAt: true, type: true, policyVersion: true } });
  const snapshots = await db.sourcePolicySnapshot.findMany({ where: { sourceId: { in: sourceIds } }, select: { id: true, sourceId: true, version: true, allowRelate: true, isLegacy: true } });
  const referenceIds = link.evidences.flatMap((evidence) => evidence.referenceEvidenceId ? [evidence.referenceEvidenceId] : []);
  const references = referenceIds.length ? await db.evidence.findMany({ where: { id: { in: referenceIds } }, select: { id: true, contact: { select: { status: true, suppressed: true, expiresAt: true, ownershipConfirmed: true, businessConfirmed: true, reviewedAt: true, type: true, normalizedValue: true, evidence: { select: { policyVersion: true, source: { select: { status: true, allowExtract: true, allowEvidenceText: true, permissionNote: true, expiresAt: true, policyVersion: true } }, policySnapshot: { select: { isLegacy: true } } } } } } } }) : [];
  const referenceSuppressionFingerprints = references.flatMap((reference) => reference.contact ? suppressionFingerprintCandidates(reference.contact.type, reference.contact.normalizedValue) : []);
  const referenceSuppressions = referenceSuppressionFingerprints.length ? await db.contactSuppression.findMany({ where: { fingerprint: { in: [...new Set(referenceSuppressionFingerprints)] }, expiresAt: { gt: new Date() } }, select: { fingerprint: true } }) : [];
  const suppressedReferences = new Set(referenceSuppressions.map((item) => item.fingerprint));
  const referenceMap = new Map(references.map((reference) => [reference.id, reference]));
  for (const evidence of link.evidences) {
    const source = states.find((item) => item.id === evidence.sourceId);
    const snapshot = snapshots.find((item) => item.sourceId === evidence.sourceId && item.version === source?.policyVersion) ?? null;
    if (!source || !canUseRelatingSource(source, snapshot)) return { usable: false, unusableReason: "LINK_POLICY_STALE" };
    const evidenceSnapshot = snapshots.find((item) => item.sourceId === evidence.sourceId && item.version === evidence.policyVersion);
    if (evidence.policyVersion !== source.policyVersion || !evidenceSnapshot || evidenceSnapshot.id !== evidence.policySnapshotId || evidenceSnapshot.isLegacy) return { usable: false, unusableReason: "LINK_POLICY_STALE" };
    if (evidence.referenceEvidenceMissing) return { usable: false, unusableReason: "LINK_EVIDENCE_REFERENCE_MISSING" };
    if (evidence.referenceEvidenceId) {
      const reference = referenceMap.get(evidence.referenceEvidenceId);
      const referenceSuppressed = reference?.contact ? suppressionFingerprintCandidates(reference.contact.type, reference.contact.normalizedValue).some((fingerprint) => suppressedReferences.has(fingerprint)) : false;
      if (!reference?.contact || referenceSuppressed || !contactUsable(reference.contact, new Date())) return { usable: false, unusableReason: "LINK_DEPENDENCY_STALE" };
    }
    if (!evidence.leftAccountVerified || !evidence.rightAccountVerified) return { usable: false, unusableReason: "LINK_EVIDENCE_INCOMPLETE" };
  }
  if (link.basis === "SHARED_CONTACT_CANDIDATE") {
    const contacts = [link.basisContact, link.matchingContact];
    if (contacts.some((contact) => !contact || contact.status !== "APPROVED" || contact.suppressed || contact.expiresAt <= new Date() || contact.evidence.sourceId !== link.sourceId || contact.evidence.policyVersion !== link.source.policyVersion || contact.evidence.policySnapshot.isLegacy)) return { usable: false, unusableReason: "LINK_DEPENDENCY_STALE" };
  }
  return { usable: true, unusableReason: null };
}

export async function evaluateAccountLink(db: Db, linkId: string) { return linkValidity(db, linkId); }

function basicValidity(item: AccountLinkRecordLike): AccountLinkValidity {
  const sourceUsable = item.source.status === "APPROVED" && item.source.allowRelate && (!item.source.expiresAt || item.source.expiresAt > new Date()) && item.source.policyVersion === item.policyVersion;
  const evidences = item.evidences ?? [];
  return { usable: item.status === "CONFIRMED" && sourceUsable && evidences.length > 0, unusableReason: item.status === "PENDING" ? "PENDING_REVIEW" : item.status === "REVOKED" ? "LINK_REVOKED" : sourceUsable ? evidences.length ? null : "LINK_EVIDENCE_MISSING" : "LINK_POLICY_STALE" };
}

export function accountLinkDto(item: AccountLinkRecordLike, role: Role, validity?: AccountLinkValidity) {
  const state = validity ?? basicValidity(item);
  const maintainer = canMaintain(role);
  const evidences = item.evidences ?? [];
  const decisions = item.decisions ?? [];
  return {
    id: item.id, status: item.status, basis: item.basis, version: item.version, usable: state.usable, unusableReason: state.unusableReason,
    createdAt: item.createdAt, updatedAt: item.updatedAt, leftAccount: item.leftAccount, rightAccount: item.rightAccount,
    source: role === "VIEWER" ? { id: item.source.id, name: item.source.name, status: item.source.status, recordedPolicyVersion: item.policyVersion, currentPolicyVersion: item.source.policyVersion } : { ...item.source, recordedPolicyVersion: item.policyVersion, currentPolicyVersion: item.source.policyVersion },
    reason: maintainer ? item.reason : null, createdBy: maintainer ? item.createdBy : null, reviewedBy: maintainer ? item.reviewedBy : null,
    evidence: maintainer ? evidences.map((evidence) => ({ id: evidence.id, sourceId: evidence.sourceId, policyVersion: evidence.policyVersion, sourceUrl: evidence.sourceUrl, capturedAt: evidence.capturedAt, fieldLocation: evidence.fieldLocation, summary: evidence.summary, leftAccountVerified: evidence.leftAccountVerified, rightAccountVerified: evidence.rightAccountVerified, createdAt: evidence.createdAt })) : [],
    history: maintainer ? decisions.map((decision) => ({ id: decision.id, round: decision.round, fromStatus: decision.fromStatus, toStatus: decision.toStatus, version: decision.version, reason: decision.reason, evidenceId: decision.evidenceId, actor: decision.actor, createdAt: decision.createdAt })) : decisions.map((decision) => ({ round: decision.round, fromStatus: decision.fromStatus, toStatus: decision.toStatus, version: decision.version, createdAt: decision.createdAt })),
  };
}

export async function createAccountLink(db: PrismaClient, actorId: string, input: AccountLinkCreateInput) {
  return withLinkTransaction(db, async (tx) => {
    await requireWriter(tx, actorId);
    const [leftAccountId, rightAccountId] = canonicalAccountPair(input.leftAccountId, input.rightAccountId);
    const sourceStates = await lockSources(tx, [input.sourceId]);
    const sourceState = sourceStates.get(input.sourceId.toLowerCase());
    if (!sourceState) throw new AccountLinkError("SOURCE_NOT_FOUND", "来源不存在", 404);
    assertSourceAllowed(sourceState);
    await lockAccountPairs(tx, [[leftAccountId, rightAccountId]]);
    if (input.basis === "SHARED_CONTACT_CANDIDATE") {
      if (!input.basisContactId || !input.matchingContactId) throw new AccountLinkError("CANDIDATE_REQUIRED", "共享联系候选必须保留两条联系证据的内部引用", 422);
      await validateSharedContactCandidate(tx, sourceState, leftAccountId, rightAccountId, input.basisContactId.toLowerCase(), input.matchingContactId.toLowerCase());
    }
    const existing = await tx.accountLink.findUnique({ where: { leftAccountId_rightAccountId: { leftAccountId, rightAccountId } }, include: accountLinkInclude });
    if (existing) {
      if (existing.status === "REVOKED") throw new AccountLinkError("LINK_REVOKED", "该关联已撤销，不能静默恢复；请建立新的人工核验记录", 409);
      return { created: false, item: existing };
    }
    const link = await tx.accountLink.create({ data: { leftAccountId, rightAccountId, sourceId: sourceState.source.id, policyVersion: sourceState.source.policyVersion, basis: input.basis, basisContactId: input.basisContactId?.toLowerCase(), matchingContactId: input.matchingContactId?.toLowerCase(), createdById: actorId }, include: accountLinkInclude });
    await tx.auditEvent.create({ data: { actorId, action: "ACCOUNT_LINK_SUGGESTED", targetId: link.id } });
    return { created: true, item: link };
  });
}

export async function suggestAccountLinksForContact(db: PrismaClient, actorId: string, contactId: string, options: { cursor?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(options.limit ?? LINK_REVIEW_LIMIT, 1), LINK_REVIEW_LIMIT);
  return withLinkTransaction(db, async (tx) => {
    await requireWriter(tx, actorId);
    const contact = await tx.contactPoint.findUnique({ where: { id: contactId }, select: { id: true, type: true, normalizedValue: true, status: true, suppressed: true, expiresAt: true, evidence: { select: { accountId: true, sourceId: true, policyVersion: true, policySnapshot: { select: { isLegacy: true } } } } } });
    if (!contact) throw new AccountLinkError("CONTACT_NOT_FOUND", "联系项不存在", 404);
    const sourceStates = await lockSources(tx, [contact.evidence.sourceId]);
    const sourceState = sourceStates.get(contact.evidence.sourceId);
    if (!sourceState) throw new AccountLinkError("SOURCE_NOT_FOUND", "来源不存在", 404);
    assertSourceAllowed(sourceState);
    if (contact.status !== "APPROVED" || contact.suppressed || contact.expiresAt <= new Date() || contact.evidence.policyVersion !== sourceState.source.policyVersion || contact.evidence.policySnapshot.isLegacy) throw new AccountLinkError("CONTACT_NOT_CURRENT", "只有当前来源策略下已审核通过且未受抑制的联系项才能生成待核验关联候选", 422);
    if (options.cursor && !isUuid(options.cursor)) throw new AccountLinkError("INVALID_CURSOR", "建议继续标识无效", 422);
    const matches = await tx.contactPoint.findMany({ where: { id: { not: contact.id }, type: contact.type, normalizedValue: contact.normalizedValue, suppressed: false, status: "APPROVED", expiresAt: { gt: new Date() }, ...(options.cursor ? { id: { gt: options.cursor } } : {}), evidence: { sourceId: sourceState.source.id, policyVersion: sourceState.source.policyVersion, accountId: { not: contact.evidence.accountId }, policySnapshot: { isLegacy: false } } }, select: { id: true, evidence: { select: { accountId: true } } }, orderBy: { id: "asc" }, take: limit + 1 });
    const hasMore = matches.length > limit;
    const pageMatches = matches.slice(0, limit);
    await lockAccountPairs(tx, pageMatches.map((match) => [contact.evidence.accountId, match.evidence.accountId]));
    const suggestions: AccountLinkRecord[] = [];
    for (const match of pageMatches) {
      const [leftAccountId, rightAccountId] = canonicalAccountPair(contact.evidence.accountId, match.evidence.accountId);
      const existing = await tx.accountLink.findUnique({ where: { leftAccountId_rightAccountId: { leftAccountId, rightAccountId } }, include: accountLinkInclude });
      if (existing) continue;
      const link = await tx.accountLink.create({ data: { leftAccountId, rightAccountId, sourceId: sourceState.source.id, policyVersion: sourceState.source.policyVersion, basis: "SHARED_CONTACT_CANDIDATE", basisContactId: contact.id, matchingContactId: match.id, createdById: actorId }, include: accountLinkInclude });
      await tx.auditEvent.create({ data: { actorId, action: "ACCOUNT_LINK_SUGGESTED", targetId: link.id } });
      suggestions.push(link);
    }
    return { items: suggestions, nextCursor: hasMore ? pageMatches.at(-1)?.id ?? null : null, hasMore };
  });
}

export async function listAccountLinks(db: PrismaClient, options: { accountId?: string; status?: AccountLinkStatus; page?: number; pageSize?: number }) {
  const pageSize = Math.min(Math.max(options.pageSize ?? 50, 1), LINK_REVIEW_LIMIT);
  const page = Math.max(options.page ?? 1, 1);
  const where = { ...(options.accountId ? { OR: [{ leftAccountId: options.accountId.toLowerCase() }, { rightAccountId: options.accountId.toLowerCase() }] } : {}), ...(options.status ? { status: options.status } : {}) };
  const [items, total] = await Promise.all([
    db.accountLink.findMany({ where, include: accountLinkInclude, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
    db.accountLink.count({ where }),
  ]);
  return { items, total, page, pageSize, hasMore: page * pageSize < total };
}

export async function getAccountLink(db: Db, linkId: string) { return loadLink(db, linkId); }

export async function reviewAccountLink(db: PrismaClient, actorId: string, linkId: string, input: AccountLinkReviewInput) {
  return withLinkTransaction(db, async (tx) => {
    await requireWriter(tx, actorId);
    const initial = await tx.accountLink.findUnique({ where: { id: linkId }, select: { id: true, sourceId: true, leftAccountId: true, rightAccountId: true } });
    if (!initial) throw new AccountLinkError("LINK_NOT_FOUND", "账号关联不存在", 404);
    const sourceStates = await lockSources(tx, [initial.sourceId, ...(input.evidence?.map((evidence) => evidence.sourceId) ?? [])]);
    await lockAccountPairs(tx, [[initial.leftAccountId, initial.rightAccountId]]);
    await tx.$queryRaw`SELECT "id" FROM "AccountLink" WHERE "id" = ${linkId}::uuid FOR UPDATE`;
    const current = await loadLink(tx, linkId);
    if (!current) throw new AccountLinkError("LINK_NOT_FOUND", "账号关联不存在", 404);
    if (current.version !== input.expectedVersion) throw new AccountLinkError("LINK_CONFLICT", "账号关联已被其他操作更新，请刷新后再审核", 409);
    if (input.status === "CONFIRMED") {
      if (current.status !== "PENDING") throw new AccountLinkError("INVALID_TRANSITION", "只有待核验关联才能确认；已撤销记录不能直接恢复", 409);
      const candidateState = sourceStates.get(current.sourceId);
      if (!candidateState) throw new AccountLinkError("SOURCE_NOT_FOUND", "来源不存在", 404);
      assertSourceAllowed(candidateState);
      if (current.policyVersion !== candidateState.source.policyVersion) throw new AccountLinkError("LINK_POLICY_STALE", "候选使用旧来源策略，不能确认；请重新建立待核验记录", 409);
      if (current.basis === "SHARED_CONTACT_CANDIDATE") {
        if (!current.basisContactId || !current.matchingContactId) throw new AccountLinkError("LINK_DEPENDENCY_STALE", "共享联系候选缺少证据引用，不能确认", 409);
        await validateSharedContactCandidate(tx, candidateState, current.leftAccountId, current.rightAccountId, current.basisContactId, current.matchingContactId);
      }
      await persistRelationEvidence(tx, current, input.evidence ?? [], actorId, sourceStates);
    } else if (current.status === "REVOKED") {
      throw new AccountLinkError("INVALID_TRANSITION", "账号关联已经撤销；如需重新核验，请建立新的核验记录", 409);
    }
    const nextVersion = input.expectedVersion + 1;
    const updated = await tx.accountLink.update({ where: { id: linkId }, data: { status: input.status, reason: input.reason, version: nextVersion, reviewedById: actorId }, include: accountLinkInclude });
    const latest = await tx.accountLinkDecision.findFirst({ where: { accountLinkId: linkId }, orderBy: { round: "desc" }, select: { round: true } });
    const firstEvidence = updated.evidences[0];
    await tx.accountLinkDecision.create({ data: { accountLinkId: linkId, round: (latest?.round ?? 0) + 1, fromStatus: current.status, toStatus: input.status, version: nextVersion, reason: input.reason, evidenceId: input.status === "CONFIRMED" ? firstEvidence?.id : undefined, actorId } });
    await tx.auditEvent.create({ data: { actorId, action: `ACCOUNT_LINK_${input.status}`, targetId: linkId } });
    return updated;
  });
}

export async function listAccountLinkHistory(db: Db, linkId: string, role: Role) {
  const decisions = await db.accountLinkDecision.findMany({ where: { accountLinkId: linkId }, orderBy: { round: "asc" }, include: { actor: { select: { id: true, email: true } } } });
  if (!canMaintain(role)) return decisions.map((decision) => ({ round: decision.round, fromStatus: decision.fromStatus, toStatus: decision.toStatus, version: decision.version, createdAt: decision.createdAt }));
  return decisions.map((decision) => ({ id: decision.id, round: decision.round, fromStatus: decision.fromStatus, toStatus: decision.toStatus, version: decision.version, reason: decision.reason, evidenceId: decision.evidenceId, actor: decision.actor, createdAt: decision.createdAt }));
}

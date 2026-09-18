import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { canManageSources, type Role } from "./permissions";
import { sourceTypeAllowed } from "./runtime-config";
import {
  buildCsv, createDownloadToken, decryptPayload, encryptPayload, payloadDigest,
  suppressionFingerprintCandidates, SUPPRESSION_FINGERPRINT_KEY_ID, tokenHash,
} from "./data-protection";
import type { ExportInput } from "./validation";
import { clearContactDependencies } from "./retention-dependencies";
import { lockContactValueKeys, lockRows } from "./resource-locks";

export class ExportError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) { super(message); }
}

export const MAX_EXPORT_ROWS = 500;
export const MAX_EXPORT_BYTES = 2 * 1024 * 1024;
const MAX_EXPORT_ACCOUNTS = 1_000;

export const EXPORT_FIELD_HEADERS = {
  ACCOUNT_ID: "account_id", PLATFORM: "platform", DISPLAY_NAME: "display_name", ORGANIZATION: "organization",
  SERVICE_TAGS: "service_tags", REGION: "region", CONTACT_TYPE: "contact_type", CONTACT_VALUE: "contact_value",
  SOURCE_URL: "source_url", CAPTURED_AT: "captured_at", REVIEWED_AT: "reviewed_at",
} as const;
export type ExportField = keyof typeof EXPORT_FIELD_HEADERS;
const CONTACT_FIELDS = new Set<ExportField>(["CONTACT_TYPE", "CONTACT_VALUE", "SOURCE_URL", "CAPTURED_AT", "REVIEWED_AT"]);
const ACCOUNT_FIELDS = (Object.keys(EXPORT_FIELD_HEADERS) as ExportField[]).filter((field) => !CONTACT_FIELDS.has(field));

type Snapshot = { id: string; version: number; allowExport: boolean | null; allowedExportFields: string | null; isLegacy: boolean };
type SourceState = { id: string; status: string; type: string; allowExport: boolean; allowedExportFields: string[]; policyVersion: number; expiresAt: Date | null; policySnapshots: Snapshot[] };

function accountWhere(userId: string, input: ExportInput): Prisma.AccountWhereInput {
  const filters = input.filters;
  return {
    ...(input.accountIds ? { id: { in: input.accountIds } } : {}),
    ...(filters.q ? { OR: [{ displayName: { contains: filters.q, mode: "insensitive" } }, { organization: { contains: filters.q, mode: "insensitive" } }] } : {}),
    ...(filters.platform ? { platform: filters.platform } : {}), ...(filters.sourceId ? { sourceId: filters.sourceId } : {}),
    ...(filters.followUpStatus ? { followUp: { status: filters.followUpStatus } } : {}),
    ...(filters.favorite === "YES" ? { favorites: { some: { userId } } } : {}), ...(filters.favorite === "NO" ? { favorites: { none: { userId } } } : {}),
  };
}

function sourceSupports(source: SourceState, fields: ExportField[], now: Date) {
  const snapshot = source.policySnapshots[0];
  let allowed: string[] | null = null;
  try { allowed = snapshot?.allowedExportFields ? JSON.parse(snapshot.allowedExportFields) as string[] : null; } catch { allowed = null; }
  return sourceTypeAllowed(source.type as "DEMO" | "AUTHORIZED_MANUAL") && source.status === "APPROVED" && source.allowExport &&
    (!source.expiresAt || source.expiresAt > now) && Boolean(snapshot && !snapshot.isLegacy && snapshot.version === source.policyVersion && snapshot.allowExport === true && allowed && fields.every((field) => allowed.includes(field)));
}

function fieldsNeedContact(fields: ExportField[]) { return fields.some((field) => CONTACT_FIELDS.has(field)); }
function sourceForContactFields(fields: ExportField[]) { return fields.filter((field) => CONTACT_FIELDS.has(field)); }
function sourceForAccountFields(fields: ExportField[]) { return fields.filter((field) => ACCOUNT_FIELDS.includes(field)); }

function suppressedByFingerprint(contact: { type: string; normalizedValue: string; suppressed?: boolean }, suppressed: Set<string>) {
  return contact.suppressed === true || suppressionFingerprintCandidates(contact.type, contact.normalizedValue).some((fingerprint) => suppressed.has(fingerprint));
}

function contactExportable(item: { contact: { status: string; ownershipConfirmed: boolean; businessConfirmed: boolean; reviewedAt: Date | null; expiresAt: Date; normalizedValue: string; type: string; rawValue: string; suppressed?: boolean }; evidence: { source: SourceState; policyVersion: number; policySnapshot: Snapshot; sourceUrl: string; capturedAt: Date } }, fields: ExportField[], now: Date, suppressed: Set<string>) {
  const contact = item.contact;
  return contact.status === "APPROVED" && contact.ownershipConfirmed && contact.businessConfirmed && Boolean(contact.reviewedAt) && contact.expiresAt > now &&
    sourceSupports(item.evidence.source, sourceForContactFields(fields), now) && item.evidence.policyVersion === item.evidence.source.policyVersion &&
    !item.evidence.policySnapshot.isLegacy && !suppressedByFingerprint(contact, suppressed);
}

function rowFor(account: { id: string; platform: string; displayName: string; organization: string | null; serviceTags: string[]; region: string | null }, fields: ExportField[], contact?: { type: string; rawValue: string; evidence: { sourceUrl: string; capturedAt: Date }; reviewedAt: Date | null }) {
  const row: Record<string, unknown> = {};
  for (const field of fields) {
    const key = EXPORT_FIELD_HEADERS[field];
    row[key] = field === "ACCOUNT_ID" ? account.id : field === "PLATFORM" ? account.platform : field === "DISPLAY_NAME" ? account.displayName :
      field === "ORGANIZATION" ? account.organization : field === "SERVICE_TAGS" ? account.serviceTags.join("|") : field === "REGION" ? account.region :
      field === "CONTACT_TYPE" ? contact?.type : field === "CONTACT_VALUE" ? contact?.rawValue : field === "SOURCE_URL" ? contact?.evidence.sourceUrl :
      field === "CAPTURED_AT" ? contact?.evidence.capturedAt.toISOString() : field === "REVIEWED_AT" ? contact?.reviewedAt?.toISOString() : "";
  }
  return row;
}

function manifestSources(fields: ExportField[], accountSource: SourceState, accountSnapshot: Snapshot, contactSource?: SourceState, contactSnapshot?: Snapshot, evidenceId?: string, contactId?: string) {
  return JSON.stringify(Object.fromEntries(fields.map((field) => {
    const source = CONTACT_FIELDS.has(field) && contactSource && contactSnapshot ? contactSource : accountSource;
    const snapshot = CONTACT_FIELDS.has(field) && contactSource && contactSnapshot ? contactSnapshot : accountSnapshot;
    return [field, { sourceId: source.id, policySnapshotId: snapshot.id, policyVersion: snapshot.version, evidenceId: CONTACT_FIELDS.has(field) ? evidenceId ?? null : null, contactId: CONTACT_FIELDS.has(field) ? contactId ?? null : null }];
  })));
}

async function activeSuppressionSet(tx: Prisma.TransactionClient, contacts: Array<{ type: string; normalizedValue: string }>, now: Date) {
  const fingerprints = [...new Set(contacts.flatMap((contact) => suppressionFingerprintCandidates(contact.type, contact.normalizedValue)))];
  if (!fingerprints.length) return new Set<string>();
  const records = await tx.contactSuppression.findMany({ where: { fingerprint: { in: fingerprints }, expiresAt: { gt: now } }, select: { fingerprint: true } });
  return new Set(records.map((record) => record.fingerprint));
}

async function lockIds(tx: Prisma.TransactionClient, table: "Source" | "Account" | "ContactPoint" | "Evidence", ids: string[]) {
  for (const id of [...new Set(ids)].sort()) await tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "id" = $1::uuid FOR UPDATE`, id);
}

type ManifestRow = { rowNumber: number; accountId: string; contactId: string | null; contactVersion: number | null; evidenceId: string | null; sourceId: string; policySnapshotId: string | null; policyVersion: number; fieldSources: string };

async function exportJobStillAllowed(tx: Prisma.TransactionClient, job: { accountIds: string[]; fieldSet: string[]; rowCount: number; manifestEntries?: ManifestRow[] }, now: Date) {
  const manifest = job.manifestEntries ?? [];
  if (!manifest.length || manifest.length !== job.rowCount || new Set(manifest.map((row) => row.rowNumber)).size !== manifest.length) return false;
  const fields = job.fieldSet as ExportField[];
  if (fields.some((field) => !(field in EXPORT_FIELD_HEADERS))) return false;
  const accountIds = [...new Set(manifest.map((row) => row.accountId))];
  if (accountIds.some((id) => !job.accountIds.includes(id))) return false;
  const accountRefs = await tx.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, sourceId: true } });
  await lockIds(tx, "Source", [...manifest.map((row) => row.sourceId), ...accountRefs.map((row) => row.sourceId)]); await lockIds(tx, "Account", accountIds);
  await lockIds(tx, "ContactPoint", manifest.flatMap((row) => row.contactId ? [row.contactId] : []));
  await lockIds(tx, "Evidence", manifest.flatMap((row) => row.evidenceId ? [row.evidenceId] : []));
  const accounts = await tx.account.findMany({ where: { id: { in: accountIds } }, include: { source: { include: { policySnapshots: { orderBy: { version: "desc" }, take: 1 } } }, followUp: { select: { status: true } } } });
  const sources = await tx.source.findMany({ where: { id: { in: [...new Set(manifest.map((row) => row.sourceId))] } }, include: { policySnapshots: { orderBy: { version: "desc" }, take: 1 } } });
  const sourceMap = new Map(sources.map((source) => [source.id, source as unknown as SourceState])); const accountMap = new Map(accounts.map((account) => [account.id, account]));
  const contacts = await tx.contactPoint.findMany({ where: { id: { in: manifest.flatMap((row) => row.contactId ? [row.contactId] : []) } }, include: { evidence: { include: { source: { include: { policySnapshots: { orderBy: { version: "desc" }, take: 1 } } }, policySnapshot: true } } } });
  const contactMap = new Map(contacts.map((contact) => [contact.id, contact])); const suppressed = await activeSuppressionSet(tx, contacts, now);
  if (accounts.length !== accountIds.length) return false;
  const needContact = fieldsNeedContact(fields);
  for (const row of manifest) {
    const account = accountMap.get(row.accountId); const primarySource = sourceMap.get(row.sourceId); const primarySnapshot = primarySource?.policySnapshots[0];
    const accountSource = account ? account.source as unknown as SourceState : null; const accountSnapshot = accountSource?.policySnapshots[0];
    if (!account || !accountSource || !accountSnapshot || account.followUp?.status === "DO_NOT_CONTACT" || !sourceSupports(accountSource, sourceForAccountFields(fields), now)) return false;
    let fieldSources: Record<string, { sourceId: string; policySnapshotId: string; policyVersion: number; evidenceId: string | null; contactId: string | null }>;
    try { fieldSources = JSON.parse(row.fieldSources) as typeof fieldSources; } catch { return false; }
    for (const field of fields) {
      const reference = fieldSources[field]; const expectedSource = CONTACT_FIELDS.has(field) ? primarySource : accountSource; const expectedSnapshot = CONTACT_FIELDS.has(field) ? primarySnapshot : accountSnapshot;
      if (!reference || !expectedSource || !expectedSnapshot || reference.sourceId !== expectedSource.id || reference.policySnapshotId !== expectedSnapshot.id || reference.policyVersion !== expectedSnapshot.version) return false;
    }
    if (row.sourceId !== primarySource?.id || primarySnapshot?.id !== row.policySnapshotId || primarySnapshot?.version !== row.policyVersion) return false;
    if (!row.contactId) { if (needContact || row.evidenceId || row.contactVersion) return false; continue; }
    const contact = contactMap.get(row.contactId);
    if (!contact || contact.version !== row.contactVersion || contact.evidenceId !== row.evidenceId || !row.evidenceId) return false;
    if (!contactExportable({ contact, evidence: contact.evidence as never }, fields, now, suppressed)) return false;
    if (contact.evidence.sourceId !== row.sourceId || contact.evidence.policySnapshotId !== row.policySnapshotId || contact.evidence.policyVersion !== row.policyVersion) return false;
  }
  return true;
}

export async function createExportJob(db: PrismaClient, userId: string, input: ExportInput) {
  const token = createDownloadToken(); const now = new Date();
  return db.$transaction(async (tx) => {
    let accounts = await tx.account.findMany({ where: accountWhere(userId, input), orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: MAX_EXPORT_ACCOUNTS + 1, include: {
      source: { include: { policySnapshots: { orderBy: { version: "desc" }, take: 1 } } }, followUp: { select: { status: true } }, favorites: { where: { userId }, select: { id: true }, take: 1 },
      evidence: { include: { contact: true, source: { include: { policySnapshots: { orderBy: { version: "desc" }, take: 1 } } }, policySnapshot: true } },
    } });
    if (accounts.length > MAX_EXPORT_ACCOUNTS) throw new ExportError("EXPORT_TOO_LARGE", "导出范围过大，请缩小筛选范围");
    const initialContacts = accounts.flatMap((account) => account.evidence.flatMap((evidence) => evidence.contact ? [evidence.contact] : []));
    await lockIds(tx, "Source", accounts.flatMap((account) => [account.sourceId, ...account.evidence.map((evidence) => evidence.sourceId)]));
    await lockContactValueKeys(tx, initialContacts);
    await lockIds(tx, "Account", accounts.map((account) => account.id));
    await lockIds(tx, "ContactPoint", initialContacts.map((contact) => contact.id));
    await lockIds(tx, "Evidence", accounts.flatMap((account) => account.evidence.map((evidence) => evidence.id)));
    accounts = await tx.account.findMany({ where: accountWhere(userId, input), orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: MAX_EXPORT_ACCOUNTS + 1, include: {
      source: { include: { policySnapshots: { orderBy: { version: "desc" }, take: 1 } } }, followUp: { select: { status: true } }, favorites: { where: { userId }, select: { id: true }, take: 1 },
      evidence: { include: { contact: true, source: { include: { policySnapshots: { orderBy: { version: "desc" }, take: 1 } } }, policySnapshot: true } },
    } });
    if (accounts.length > MAX_EXPORT_ACCOUNTS) throw new ExportError("EXPORT_TOO_LARGE", "导出范围过大，请缩小筛选范围");
    const fields = input.fields as ExportField[]; const contacts = accounts.flatMap((account) => account.evidence.flatMap((evidence) => evidence.contact ? [evidence.contact] : []));
    const suppressed = await activeSuppressionSet(tx, contacts, now); const rows: Array<Record<string, unknown>> = []; const manifests: ManifestRow[] = [];
    const reasonCounts: Record<string, number> = {}; let excludedCount = 0; const exclude = (reason: string) => { excludedCount += 1; reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1; };
    for (const account of accounts) {
      const accountSource = account.source as unknown as SourceState; const accountSnapshot = accountSource.policySnapshots[0]; const accountFields = sourceForAccountFields(fields);
      if (account.followUp?.status === "DO_NOT_CONTACT") { exclude("DO_NOT_CONTACT"); continue; }
      if (!accountSnapshot || !sourceSupports(accountSource, accountFields, now)) { exclude("SOURCE_OR_FIELD_POLICY"); continue; }
      const contactsForAccount = account.evidence.flatMap((evidence) => evidence.contact && contactExportable({ contact: evidence.contact, evidence: evidence as never }, fields, now, suppressed) ? [{ contact: evidence.contact, evidence }] : []);
      if (fieldsNeedContact(fields) && contactsForAccount.length === 0) { exclude("NO_USABLE_CONTACT"); continue; }
      for (const selectedContact of (fieldsNeedContact(fields) ? contactsForAccount : [undefined])) {
        const source = selectedContact ? selectedContact.evidence.source as unknown as SourceState : accountSource; const snapshot = source.policySnapshots[0];
        if (!snapshot || !sourceSupports(source, sourceForContactFields(fields), now)) { exclude("SOURCE_OR_FIELD_POLICY"); continue; }
        const rowNumber = rows.length + 1;
        rows.push(rowFor(account, fields, selectedContact ? { type: selectedContact.contact.type, rawValue: selectedContact.contact.rawValue, evidence: { sourceUrl: selectedContact.evidence.sourceUrl, capturedAt: selectedContact.evidence.capturedAt }, reviewedAt: selectedContact.contact.reviewedAt } : undefined));
        manifests.push({ rowNumber, accountId: account.id, contactId: selectedContact?.contact.id ?? null, contactVersion: selectedContact?.contact.version ?? null, evidenceId: selectedContact?.evidence.id ?? null, sourceId: source.id, policySnapshotId: snapshot.id, policyVersion: snapshot.version, fieldSources: manifestSources(fields, accountSource, accountSnapshot, selectedContact ? source : undefined, selectedContact ? snapshot : undefined, selectedContact?.evidence.id, selectedContact?.contact.id) });
      }
    }
    if (rows.length > MAX_EXPORT_ROWS) throw new ExportError("EXPORT_TOO_LARGE", `导出最多 ${MAX_EXPORT_ROWS} 条最终数据行，请缩小筛选范围`);
    if (!rows.length) throw new ExportError("NO_EXPORTABLE_ROWS", "没有同时满足当前来源策略、人工审核、有效期和拒绝联系规则的记录");
    const csv = buildCsv(fields.map((field) => EXPORT_FIELD_HEADERS[field]), rows); if (Buffer.byteLength(csv, "utf8") > MAX_EXPORT_BYTES) throw new ExportError("EXPORT_TOO_LARGE_BYTES", "导出文件超过 2 MiB，请缩小字段或筛选范围");
    const expiresAt = new Date(now.getTime() + input.expiresInMinutes * 60_000);
    const job = await tx.exportJob.create({ data: { createdById: userId, tokenHash: tokenHash(token), encryptedPayload: encryptPayload(csv), payloadDigest: payloadDigest(csv), accountIds: [...new Set(manifests.map((manifest) => manifest.accountId))], fieldSet: fields, filterSummary: JSON.stringify(input.filters), rowCount: rows.length, excludedCount, excludedReasonCounts: JSON.stringify(reasonCounts), expiresAt, manifestEntries: { create: manifests } } });
    await tx.auditEvent.create({ data: { actorId: userId, action: "EXPORT_CREATED", targetId: job.id } });
    return { id: job.id, token, expiresAt, rowCount: rows.length, excludedCount, excludedReasonCounts: reasonCounts };
  });
}

export async function downloadExport(db: PrismaClient, userId: string, jobId: string, token: string) {
  const decision = await db.$transaction(async (tx) => {
    const preview = await tx.exportJob.findUnique({ where: { id: jobId }, include: { manifestEntries: { orderBy: { rowNumber: "asc" } } } });
    if (!preview || preview.createdById !== userId) throw new ExportError("EXPORT_NOT_FOUND", "导出链接不存在", 404);
    const manifestContactIds = preview.manifestEntries.flatMap((row) => row.contactId ? [row.contactId] : []);
    const previewContacts = manifestContactIds.length ? await tx.contactPoint.findMany({ where: { id: { in: manifestContactIds } }, select: { type: true, normalizedValue: true } }) : [];
    await lockIds(tx, "Source", preview.manifestEntries.map((row) => row.sourceId));
    await lockContactValueKeys(tx, previewContacts);
    await lockIds(tx, "Account", preview.manifestEntries.map((row) => row.accountId));
    await lockIds(tx, "ContactPoint", manifestContactIds);
    await lockIds(tx, "Evidence", preview.manifestEntries.flatMap((row) => row.evidenceId ? [row.evidenceId] : []));
    await lockRows(tx, "ExportJob", [jobId]);
    const current = await tx.exportJob.findUnique({ where: { id: jobId }, include: { manifestEntries: { orderBy: { rowNumber: "asc" } } } });
    if (!current || current.createdById !== userId) throw new ExportError("EXPORT_NOT_FOUND", "导出链接不存在", 404);
    const invalidate = async (status: "EXPIRED" | "REVOKED", code: string, message: string) => {
      await tx.exportJob.update({ where: { id: jobId }, data: { status, encryptedPayload: "", tokenHash: tokenHash(createDownloadToken()) } });
      await tx.auditEvent.create({ data: { actorId: userId, action: status === "EXPIRED" ? "EXPORT_EXPIRED" : "EXPORT_REVOKED", targetId: jobId } });
      return { kind: "error" as const, error: new ExportError(code, message, 410) };
    };
    if (current.status !== "READY") return { kind: "error" as const, error: new ExportError("EXPORT_USED", "导出链接已使用或已撤销", 410) };
    if (current.tokenHash !== tokenHash(token)) throw new ExportError("EXPORT_NOT_FOUND", "导出链接不存在", 404);
    if (current.expiresAt <= new Date()) return invalidate("EXPIRED", "EXPORT_EXPIRED", "导出链接已过期");
    if (!current.manifestEntries.length) return invalidate("REVOKED", "EXPORT_LEGACY_UNSUPPORTED", "旧导出缺少不可变清单，导出链接已撤销");
    if (!(await exportJobStillAllowed(tx, current, new Date()))) return invalidate("REVOKED", "EXPORT_REVOKED", "来源策略、联系人有效性或拒绝联系状态已变化，导出链接已撤销");
    let csv: string;
    try { csv = decryptPayload(current.encryptedPayload); if (!current.payloadDigest || payloadDigest(csv) !== current.payloadDigest || Buffer.byteLength(csv, "utf8") > MAX_EXPORT_BYTES) throw new Error("PAYLOAD_INVALID"); }
    catch { return invalidate("REVOKED", "EXPORT_PAYLOAD_INVALID", "导出载荷完整性校验失败，导出链接已撤销"); }
    await tx.exportJob.update({ where: { id: jobId }, data: { status: "DOWNLOADED", downloadedAt: new Date(), encryptedPayload: "", tokenHash: tokenHash(createDownloadToken()) } });
    await tx.auditEvent.create({ data: { actorId: userId, action: "EXPORT_DOWNLOADED", targetId: jobId } });
    return { kind: "success" as const, csv };
  });
  if (decision.kind === "error") throw decision.error;
  return { csv: decision.csv, filename: `test3-export-${jobId}.csv` };
}

export async function listExportJobs(db: PrismaClient, userId: string) {
  return db.exportJob.findMany({ where: { createdById: userId }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, fieldSet: true, rowCount: true, excludedCount: true, excludedReasonCounts: true, status: true, expiresAt: true, downloadedAt: true, createdAt: true } });
}

export async function deleteExportArtifactsForAccounts(tx: Prisma.TransactionClient, accountIds: string[]) {
  if (!accountIds.length) return 0;
  return (await tx.exportJob.deleteMany({ where: { accountIds: { hasSome: accountIds } } })).count;
}

export type RetentionCleanupOptions = { batchSize?: number; contactCursor?: string; exportCursor?: string; suppressionCursor?: string; contactDone?: boolean; exportDone?: boolean; suppressionDone?: boolean; dryRun?: boolean };

export async function runRetentionCleanup(db: PrismaClient, actorId: string, now = new Date(), options: RetentionCleanupOptions = {}) {
  const batchSize = Math.min(Math.max(options.batchSize ?? 50, 1), 100);
  if (options.dryRun) {
    const [contacts, exports, suppressions] = await Promise.all([
      db.contactPoint.count({ where: { expiresAt: { lte: now }, ...(options.contactCursor ? { id: { gt: options.contactCursor } } : {}) } }),
      db.exportJob.count({ where: { expiresAt: { lte: now }, ...(options.exportCursor ? { id: { gt: options.exportCursor } } : {}) } }),
      db.contactSuppression.count({ where: { expiresAt: { lte: now }, ...(options.suppressionCursor ? { id: { gt: options.suppressionCursor } } : {}) } }),
    ]);
    return { contacts, exports, suppressions, dryRun: true, next: { contactCursor: null, contactDone: true, exportCursor: null, exportDone: true, suppressionCursor: null, suppressionDone: true }, complete: true };
  }
  return db.$transaction(async (tx) => {
    const expiredContacts = options.contactDone ? [] : await tx.contactPoint.findMany({ where: { expiresAt: { lte: now }, ...(options.contactCursor ? { id: { gt: options.contactCursor } } : {}) }, orderBy: { id: "asc" }, take: batchSize, include: { evidence: { select: { id: true, accountId: true } } } });
    const contactIds = expiredContacts.map((contact) => contact.id); const accountIds = [...new Set(expiredContacts.map((contact) => contact.evidence.accountId))];
    await lockIds(tx, "Account", accountIds); await lockIds(tx, "ContactPoint", contactIds); await lockIds(tx, "Evidence", expiredContacts.map((contact) => contact.evidence.id));
    for (const contact of expiredContacts) await clearContactDependencies(tx, contact.id, contact.evidence.id, contact.evidence.accountId);
    const expiredExports = options.exportDone ? [] : await tx.exportJob.findMany({ where: { expiresAt: { lte: now }, ...(options.exportCursor ? { id: { gt: options.exportCursor } } : {}) }, orderBy: { id: "asc" }, take: batchSize, select: { id: true } });
    const expiredSuppressions = options.suppressionDone ? [] : await tx.contactSuppression.findMany({ where: { expiresAt: { lte: now }, ...(options.suppressionCursor ? { id: { gt: options.suppressionCursor } } : {}) }, orderBy: { id: "asc" }, take: batchSize, select: { id: true } });
    await lockRows(tx, "ExportJob", expiredExports.map((item) => item.id));
    if (expiredExports.length) await tx.exportJob.deleteMany({ where: { id: { in: expiredExports.map((item) => item.id) } } });
    if (expiredSuppressions.length) await tx.contactSuppression.deleteMany({ where: { id: { in: expiredSuppressions.map((item) => item.id) } } });
    await tx.auditEvent.create({ data: { actorId, action: "RETENTION_CLEANUP", targetId: actorId } });
    const next = { contactCursor: expiredContacts.length === batchSize ? expiredContacts.at(-1)?.id ?? null : null, contactDone: options.contactDone === true || expiredContacts.length < batchSize, exportCursor: expiredExports.length === batchSize ? expiredExports.at(-1)?.id ?? null : null, exportDone: options.exportDone === true || expiredExports.length < batchSize, suppressionCursor: expiredSuppressions.length === batchSize ? expiredSuppressions.at(-1)?.id ?? null : null, suppressionDone: options.suppressionDone === true || expiredSuppressions.length < batchSize };
    return { contacts: expiredContacts.length, exports: expiredExports.length, suppressions: expiredSuppressions.length, dryRun: false, next, complete: next.contactDone && next.exportDone && next.suppressionDone };
  });
}

export function canExport(role: Role) { return canManageSources(role); }
export const exportFingerprintMetadata = { keyId: SUPPRESSION_FINGERPRINT_KEY_ID };

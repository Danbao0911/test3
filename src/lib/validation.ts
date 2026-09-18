import { z } from "zod";

export const platformValues = ["XIAOHONGSHU", "YOUTUBE", "X", "DOUYIN"] as const;
export const sourceTypeValues = ["DEMO", "AUTHORIZED_MANUAL"] as const;
export const sourceStatusValues = ["DRAFT", "APPROVED", "REVOKED"] as const;
export const followUpStatusValues = ["NOT_CONTACTED", "CONTACTING", "REPLIED", "NOT_MATCH", "DO_NOT_CONTACT"] as const;

const optionalText = (max: number) =>
  z.preprocess(
    (value) => (value === "" || value === undefined ? null : typeof value === "string" ? value.trim() : value),
    z.string().max(max).nullable(),
  );

export const accountInputSchema = z
  .object({
    platform: z.enum(platformValues),
    nativeId: z.preprocess(
      (value) => (value === "" || value === undefined || typeof value === "string" && value.trim() === "" ? null : typeof value === "string" ? value.trim() : value),
      z.string().max(200).nullable(),
    ),
    displayName: z.string().trim().min(1).max(120),
    profileUrl: z.string().trim().min(1).max(2048),
    organization: optionalText(200),
    serviceTags: z.array(z.string().trim().min(1).max(40)).max(10),
    region: optionalText(100),
    sourceId: z.string().uuid(),
    sourceUrl: z.string().trim().min(1).max(2048),
  })
  .strict();

export type AccountInput = z.infer<typeof accountInputSchema>;

export const accountPatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    organization: optionalText(200).optional(),
    serviceTags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
    region: optionalText(100).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "至少提供一个可修改字段");

export const followUpPatchSchema = z
  .object({
    expectedWorkspaceVersion: z.number().int().positive(),
    status: z.enum(followUpStatusValues),
    note: z.string().trim().max(1000),
    confirmReactivation: z.boolean().optional(),
  })
  .strict();

export const workspacePatchSchema = z
  .object({
    expectedWorkspaceVersion: z.number().int().positive(),
    ownerId: z.string().uuid().nullable().optional(),
    followUp: z.object({
      status: z.enum(followUpStatusValues),
      note: z.string().trim().max(1000),
      confirmReactivation: z.boolean().optional(),
    }).strict().optional(),
  })
  .strict()
  .refine((value) => value.ownerId !== undefined || value.followUp !== undefined, "至少提供负责人或跟进修改");

export const sourceCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    type: z.enum(sourceTypeValues),
    permissionNote: z.string().trim().max(2000).default(""),
  })
  .strict();

export const sourcePatchSchema = z
  .object({
    expectedPolicyVersion: z.number().int().positive(),
    permissionNote: z.string().trim().max(2000).optional(),
    status: z.enum(sourceStatusValues).optional(),
    allowImport: z.boolean().optional(),
    allowExtract: z.boolean().optional(),
    allowEvidenceText: z.boolean().optional(),
    allowRelate: z.boolean().optional(),
    retentionDays: z.number().int().min(1).max(365).optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "至少提供一个来源修改字段");

export const accountLinkCreateSchema = z
  .object({
    leftAccountId: z.string().uuid(),
    rightAccountId: z.string().uuid(),
    sourceId: z.string().uuid(),
    basis: z.enum(["MANUAL", "SHARED_CONTACT_CANDIDATE"]),
    basisContactId: z.string().uuid().optional(),
    matchingContactId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.basis === "SHARED_CONTACT_CANDIDATE" && (!value.basisContactId || !value.matchingContactId)) {
      context.addIssue({ code: "custom", path: ["basisContactId"], message: "共享联系候选必须保留两条联系证据的内部引用" });
    }
    if (value.basis === "MANUAL" && (value.basisContactId || value.matchingContactId)) {
      context.addIssue({ code: "custom", path: ["basisContactId"], message: "人工关联不能伪造共享联系证据" });
    }
  });

export const accountLinkReviewSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    status: z.enum(["CONFIRMED", "REVOKED"]),
    reason: z.string().trim().min(1).max(500),
    evidence: z.array(z.object({
      sourceId: z.uuid(),
      referenceEvidenceId: z.uuid().optional(),
      sourceUrl: z.string().trim().min(1).max(2048).optional(),
      capturedAt: z.iso.datetime({ offset: true }),
      fieldLocation: z.string().trim().min(1).max(240),
      summary: z.string().trim().min(1).max(500),
      leftAccountId: z.uuid(),
      rightAccountId: z.uuid(),
      leftAccountVerified: z.boolean(),
      rightAccountVerified: z.boolean(),
    }).strict()).max(4).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "CONFIRMED" && !value.evidence?.length) {
      context.addIssue({ code: "custom", path: ["evidence"], message: "确认关联必须提交至少一条关系专用证据" });
    }
    for (const [index, item] of (value.evidence ?? []).entries()) {
      if (!item.sourceUrl && !item.referenceEvidenceId) {
        context.addIssue({ code: "custom", path: ["evidence", index, "sourceUrl"], message: "证据必须包含来源地址或已有证据引用" });
      }
      if (item.leftAccountId === item.rightAccountId) {
        context.addIssue({ code: "custom", path: ["evidence", index], message: "证据必须同时指向两个不同账号" });
      }
      if (!item.leftAccountVerified || !item.rightAccountVerified) {
        context.addIssue({ code: "custom", path: ["evidence", index], message: "必须分别核验两侧账号" });
      }
    }
  });

export const accountLinkSuggestionSchema = z.object({
  contactId: z.uuid(),
  cursor: z.uuid().optional(),
  limit: z.number().int().min(1).max(50).default(50),
}).strict();

export const loginSchema = z
  .object({
    email: z.string().trim().email().max(320),
    password: z.string().min(1).max(200),
  })
  .strict();

export const uuidSchema = z.string().uuid();

export function validationMessage(error: z.ZodError) {
  const issue = error.issues[0];
  const path = issue?.path.length ? issue.path.join(".") : "row";
  return `${path}: ${issue?.message ?? "字段格式错误"}`;
}

export function parsePositiveInt(value: string | null, fallback: number, max: number) {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

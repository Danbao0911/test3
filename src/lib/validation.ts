import { z } from "zod";

export const platformValues = ["XIAOHONGSHU", "YOUTUBE", "X", "DOUYIN"] as const;
export const sourceTypeValues = ["DEMO", "AUTHORIZED_MANUAL"] as const;
export const sourceStatusValues = ["DRAFT", "APPROVED", "REVOKED"] as const;

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

export const sourceCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    type: z.enum(sourceTypeValues),
    permissionNote: z.string().trim().max(2000).default(""),
  })
  .strict();

export const sourcePatchSchema = z
  .object({
    permissionNote: z.string().trim().max(2000).optional(),
    status: z.enum(sourceStatusValues).optional(),
    allowImport: z.boolean().optional(),
    allowExtract: z.boolean().optional(),
    allowEvidenceText: z.boolean().optional(),
    retentionDays: z.number().int().min(1).max(365).optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "至少提供一个来源修改字段");

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

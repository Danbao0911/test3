import { z } from "zod";

export const extractionSchema = z.object({
  accountId: z.uuid(),
  sourceId: z.uuid(),
  sourceUrl: z.string().trim().min(1).max(2048),
  capturedAt: z.iso.datetime({ offset: true }),
  fieldLocation: z.string().trim().min(1).max(180),
  context: z.enum(["ACCOUNT_PROFILE", "COMMENT", "ADVERTISEMENT", "THIRD_PARTY"]),
  text: z.string().max(5000),
}).strict();

export const reviewSchema = z.object({
  version: z.number().int().min(1),
  status: z.enum(["APPROVED", "REJECTED", "INVALID"]),
  ownershipConfirmed: z.boolean(),
  businessConfirmed: z.boolean(),
  reason: z.string().trim().min(1).max(500),
}).strict();

export type ExtractionInput = z.infer<typeof extractionSchema>;
export type ReviewInput = z.infer<typeof reviewSchema>;

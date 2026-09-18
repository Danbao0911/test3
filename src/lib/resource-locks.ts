import type { Prisma } from "@/generated/prisma/client";
import { suppressionFingerprint } from "./data-protection";

/**
 * Cross-service lock order. Every transaction that can touch more than one of
 * these resources must acquire them in this order and re-read after locking:
 * source -> suppression/identity fingerprint -> account -> contact -> evidence
 * -> account-link pair -> export job.
 */
export const RESOURCE_LOCK_ORDER = ["source", "fingerprint", "account", "contact", "evidence", "account_link", "export_job"] as const;

export async function lockAdvisoryKeys(tx: Prisma.TransactionClient, keys: string[]) {
  for (const key of [...new Set(keys)].sort()) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text AS locked`;
  }
}

export async function lockContactValueKeys(tx: Prisma.TransactionClient, values: Array<{ type: string; normalizedValue: string }>) {
  await lockAdvisoryKeys(tx, values.map((value) => `test3:suppression:${suppressionFingerprint(value.type, value.normalizedValue)}`));
}

type LockTable = "Source" | "Account" | "ContactPoint" | "Evidence" | "AccountLink" | "ExportJob";

export async function lockRows(tx: Prisma.TransactionClient, table: LockTable, ids: string[]) {
  for (const id of [...new Set(ids)].sort()) {
    await tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "id" = $1::uuid FOR UPDATE`, id);
  }
}

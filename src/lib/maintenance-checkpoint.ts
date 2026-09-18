import { createHmac, timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";

export type MaintenanceOperation = "cleanup" | "replay";
export type MaintenanceMode = "dry-run" | "execute";
export type MaintenanceCursors = Record<string, string | boolean | null | undefined>;

type CheckpointBody = {
  v: 2;
  operation: MaintenanceOperation;
  mode: MaintenanceMode;
  database: string;
  targetFingerprint: string;
  runId: string;
  cutoff: string;
  cursors: MaintenanceCursors;
};

function checkpointKey() {
  const configured = process.env.RETENTION_CHECKPOINT_KEY;
  if (!configured && process.env.APP_MODE === "production") throw new Error("生产环境必须配置 RETENTION_CHECKPOINT_KEY");
  return createHash("sha256").update(configured ?? `test3-retention-checkpoint-${process.env.TEST_RUN_ID ?? "local"}`).digest();
}

function encodePart(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodePart(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(body: string) {
  return createHmac("sha256", checkpointKey()).update(body).digest("base64url");
}

/**
 * Binds a checkpoint to the non-secret connection target and this isolated
 * run.  The password and full connection URL never enter the token.
 */
export function maintenanceTargetFingerprint(databaseUrl: string | URL, runId: string) {
  const url = typeof databaseUrl === "string" ? new URL(databaseUrl) : databaseUrl;
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return createHash("sha256")
    .update([url.protocol, url.hostname, url.port || "5432", database, runId].join("\0"))
    .digest("hex");
}

export function encodeMaintenanceCheckpoint(input: Omit<CheckpointBody, "v">) {
  const body = JSON.stringify({ v: 2, ...input } satisfies CheckpointBody);
  return `${encodePart(body)}.${sign(body)}`;
}

export function decodeMaintenanceCheckpoint(token: string, expected: { operation: MaintenanceOperation; mode: MaintenanceMode; database: string; targetFingerprint: string; runId: string }) {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("checkpoint 格式无效");
  let bodyText: string;
  try { bodyText = decodePart(parts[0]); } catch { throw new Error("checkpoint 编码无效"); }
  const actualSignature = Buffer.from(parts[1], "base64url");
  const expectedSignature = Buffer.from(sign(bodyText), "base64url");
  if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) throw new Error("checkpoint 签名无效");
  let body: unknown;
  try { body = JSON.parse(bodyText); } catch { throw new Error("checkpoint 内容无效"); }
  if (!body || typeof body !== "object") throw new Error("checkpoint 内容无效");
  const value = body as Partial<CheckpointBody>;
  if (value.v !== 2 || value.operation !== expected.operation || value.mode !== expected.mode || value.database !== expected.database || value.targetFingerprint !== expected.targetFingerprint || value.runId !== expected.runId || typeof value.cutoff !== "string" || !Number.isFinite(new Date(value.cutoff).getTime()) || !value.cursors || typeof value.cursors !== "object") throw new Error("checkpoint 版本、模式、目标或截止时间不匹配");
  const allowedKeys = value.operation === "replay"
    ? new Set(["accountCursor", "contactCursor", "accountDone", "contactDone"])
    : new Set(["contactCursor", "exportCursor", "suppressionCursor", "contactDone", "exportDone", "suppressionDone"]);
  for (const [key, cursor] of Object.entries(value.cursors)) {
    const validCursor = cursor === null || typeof cursor === "boolean" || typeof cursor === "undefined" || (typeof cursor === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(cursor));
    if (!allowedKeys.has(key) || !validCursor) throw new Error("checkpoint 游标无效");
  }
  return { cutoff: new Date(value.cutoff), cursors: value.cursors as MaintenanceCursors };
}

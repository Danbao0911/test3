import { createHmac, timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";

export type MaintenanceOperation = "cleanup" | "replay";
export type MaintenanceCursors = Record<string, string | boolean | null | undefined>;

type CheckpointBody = {
  v: 1;
  operation: MaintenanceOperation;
  database: string;
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

export function encodeMaintenanceCheckpoint(input: Omit<CheckpointBody, "v">) {
  const body = JSON.stringify({ v: 1, ...input } satisfies CheckpointBody);
  return `${encodePart(body)}.${sign(body)}`;
}

export function decodeMaintenanceCheckpoint(token: string, expected: { operation: MaintenanceOperation; database: string; runId: string }) {
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
  if (value.v !== 1 || value.operation !== expected.operation || value.database !== expected.database || value.runId !== expected.runId || typeof value.cutoff !== "string" || !Number.isFinite(new Date(value.cutoff).getTime()) || !value.cursors || typeof value.cursors !== "object") throw new Error("checkpoint 目标或截止时间不匹配");
  for (const [key, cursor] of Object.entries(value.cursors)) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || !(cursor === null || typeof cursor === "boolean" || typeof cursor === "undefined" || (typeof cursor === "string" && cursor.length <= 80))) throw new Error("checkpoint 游标无效");
  }
  return { cutoff: new Date(value.cutoff), cursors: value.cursors as MaintenanceCursors };
}

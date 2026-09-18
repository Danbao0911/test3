import { assertRuntimeConfiguration } from "../src/lib/runtime-config";
import { prisma } from "../src/lib/db";
import { replayDeletionRules } from "../src/lib/retention-service";
import { runRetentionCleanup } from "../src/lib/export-service";

function flag(name: string) { return process.argv.includes(name); }
function value(name: string, fallback: number) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const parsed = Number(process.argv[index + 1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function main() {
  const operation = process.argv[2];
  if (operation !== "cleanup" && operation !== "replay") throw new Error("用法：pnpm retention:cleanup [--dry-run] 或 pnpm retention:replay [--dry-run]");
  const { databaseTarget } = assertRuntimeConfiguration();
  if (process.env.APP_MODE === "production") throw new Error("生命周期维护命令拒绝生产模式");
  const dryRun = flag("--dry-run");
  if (!dryRun && process.env.RETENTION_MAINTENANCE_CONFIRM !== "1") throw new Error("非 dry-run 维护需要 RETENTION_MAINTENANCE_CONFIRM=1");
  const actorId = process.env.RETENTION_MAINTENANCE_ACTOR_ID;
  if (!actorId) throw new Error("必须设置 RETENTION_MAINTENANCE_ACTOR_ID");
  const now = new Date();
  if (operation === "replay") {
    const result = await replayDeletionRules(prisma, actorId, { dryRun, now });
    console.log(JSON.stringify({ operation, database: databaseTarget.name, ...result }));
    return;
  }
  const batchSize = Math.min(value("--batch-size", 50), 100);
  const maxBatches = value("--max-batches", 100);
  let cursors: { contactCursor?: string; exportCursor?: string; suppressionCursor?: string } = {};
  let total = { contacts: 0, exports: 0, suppressions: 0 };
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await runRetentionCleanup(prisma, actorId, now, { ...cursors, batchSize, dryRun });
    total = { contacts: total.contacts + result.contacts, exports: total.exports + result.exports, suppressions: total.suppressions + result.suppressions };
    if (dryRun || !result.next || (!result.next.contactCursor && !result.next.exportCursor && !result.next.suppressionCursor)) break;
    cursors = { contactCursor: result.next.contactCursor ?? undefined, exportCursor: result.next.exportCursor ?? undefined, suppressionCursor: result.next.suppressionCursor ?? undefined };
  }
  console.log(JSON.stringify({ operation, database: databaseTarget.name, dryRun, ...total }));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "maintenance failed"); process.exitCode = 1; });

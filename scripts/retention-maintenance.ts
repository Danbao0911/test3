import { assertRuntimeConfiguration } from "../src/lib/runtime-config";
import { prisma } from "../src/lib/db";
import { replayDeletionRules } from "../src/lib/retention-service";
import { runRetentionCleanup } from "../src/lib/export-service";
import { decodeMaintenanceCheckpoint, encodeMaintenanceCheckpoint, type MaintenanceCursors, type MaintenanceOperation } from "../src/lib/maintenance-checkpoint";

function flag(name: string) { return process.argv.includes(name); }

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function value(name: string, fallback: number) {
  const raw = argument(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} 必须是正整数`);
  return parsed;
}

function runId() {
  const value = process.env.RETENTION_RUN_ID ?? process.env.TEST_RUN_ID;
  if (!value) throw new Error("必须设置 RETENTION_RUN_ID（测试环境使用 TEST_RUN_ID）以绑定 checkpoint");
  return value;
}

function checkpointFor(operation: MaintenanceOperation, database: string, cursors: MaintenanceCursors, cutoff: Date) {
  return encodeMaintenanceCheckpoint({ operation, database, runId: runId(), cutoff: cutoff.toISOString(), cursors });
}

async function main() {
  const operation = process.argv[2] as MaintenanceOperation | undefined;
  if (operation !== "cleanup" && operation !== "replay") throw new Error("用法：pnpm retention:cleanup -- [--dry-run] 或 pnpm retention:replay -- [--dry-run]");
  const { databaseTarget } = assertRuntimeConfiguration();
  if (process.env.APP_MODE === "production") throw new Error("生命周期维护命令拒绝生产模式");
  const dryRun = flag("--dry-run");
  if (!dryRun && process.env.RETENTION_MAINTENANCE_CONFIRM !== "1") throw new Error("非 dry-run 维护需要 RETENTION_MAINTENANCE_CONFIRM=1");
  const actorId = process.env.RETENTION_MAINTENANCE_ACTOR_ID;
  if (!actorId) throw new Error("必须设置 RETENTION_MAINTENANCE_ACTOR_ID");
  const checkpointToken = argument("--checkpoint");
  const checkpoint = checkpointToken ? decodeMaintenanceCheckpoint(checkpointToken, { operation, database: databaseTarget.name, runId: runId() }) : undefined;
  const now = checkpoint?.cutoff ?? new Date();
  try {
    if (operation === "replay") {
      const batchSize = Math.min(value("--batch-size", 100), 1_000);
      const maxBatches = value("--max-batches", 100);
      let cursors: { accountCursor?: string; contactCursor?: string; accountDone?: boolean; contactDone?: boolean } = checkpoint?.cursors as typeof cursors ?? {};
      const total = { scanned: { accounts: 0, contacts: 0 }, matched: { accounts: 0, contacts: 0 }, deleted: { accounts: 0, contacts: 0 } };
      let last: Awaited<ReturnType<typeof replayDeletionRules>> | undefined;
      for (let batch = 0; batch < maxBatches; batch += 1) {
        last = await replayDeletionRules(prisma, actorId, { dryRun, now, batchSize, ...cursors });
        total.scanned.accounts += last.scanned.accounts; total.scanned.contacts += last.scanned.contacts;
        total.matched.accounts += last.matched.accounts; total.matched.contacts += last.matched.contacts;
        total.deleted.accounts += last.deleted.accounts; total.deleted.contacts += last.deleted.contacts;
        cursors = { accountCursor: last.next.accountCursor ?? undefined, contactCursor: last.next.contactCursor ?? undefined, accountDone: last.next.accountDone, contactDone: last.next.contactDone };
        if (!last.hasMore) break;
      }
      const scanComplete = last?.scanComplete === true;
      const enforcementComplete = last?.enforcementComplete === true;
      const complete = scanComplete && enforcementComplete;
      const continuation = complete || scanComplete ? null : checkpointFor(operation, databaseTarget.name, cursors, now);
      console.log(JSON.stringify({ operation, database: databaseTarget.name, dryRun, complete, scanComplete, enforcementComplete, incomplete: !complete, continuation, ...total, blockedRules: last?.blockedRules ?? 0, legacyUnknown: last?.legacyUnknown ?? 0, rules: last?.rules ?? 0 }));
      if (!scanComplete) process.exitCode = 2;
      else if (!enforcementComplete) process.exitCode = 3;
      return;
    }

    const batchSize = Math.min(value("--batch-size", 50), 100);
    const maxBatches = value("--max-batches", 100);
    let cursors: { contactCursor?: string; exportCursor?: string; suppressionCursor?: string; contactDone?: boolean; exportDone?: boolean; suppressionDone?: boolean } = checkpoint?.cursors as typeof cursors ?? {};
    let total = { contacts: 0, exports: 0, suppressions: 0 };
    let last: Awaited<ReturnType<typeof runRetentionCleanup>> | undefined;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      last = await runRetentionCleanup(prisma, actorId, now, { ...cursors, batchSize, dryRun });
      total = { contacts: total.contacts + last.contacts, exports: total.exports + last.exports, suppressions: total.suppressions + last.suppressions };
      cursors = { contactCursor: last.next?.contactCursor ?? undefined, exportCursor: last.next?.exportCursor ?? undefined, suppressionCursor: last.next?.suppressionCursor ?? undefined, contactDone: last.next?.contactDone, exportDone: last.next?.exportDone, suppressionDone: last.next?.suppressionDone };
      if (last.complete) break;
    }
    const complete = last?.complete === true;
    const continuation = complete ? null : checkpointFor(operation, databaseTarget.name, cursors, now);
    console.log(JSON.stringify({ operation, database: databaseTarget.name, dryRun, complete, incomplete: !complete, continuation, ...total }));
    if (!complete) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "maintenance failed"); process.exitCode = 1; });

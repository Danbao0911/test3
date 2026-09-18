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
    const batchSize = Math.min(value("--batch-size", 100), 1_000);
    const maxBatches = value("--max-batches", 100);
    let cursors: { accountCursor?: string; contactCursor?: string; accountDone?: boolean; contactDone?: boolean } = {};
    const total = { scanned: { accounts: 0, contacts: 0 }, matched: { accounts: 0, contacts: 0 }, deleted: { accounts: 0, contacts: 0 } };
    let last: Awaited<ReturnType<typeof replayDeletionRules>> | undefined;
    let complete = false;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      last = await replayDeletionRules(prisma, actorId, { dryRun, now, batchSize, ...cursors });
      total.scanned.accounts += last.scanned.accounts; total.scanned.contacts += last.scanned.contacts;
      total.matched.accounts += last.matched.accounts; total.matched.contacts += last.matched.contacts;
      total.deleted.accounts += last.deleted.accounts; total.deleted.contacts += last.deleted.contacts;
      if (!last.hasMore) { complete = true; break; }
      cursors = { accountCursor: last.next.accountCursor ?? undefined, contactCursor: last.next.contactCursor ?? undefined, accountDone: last.next.accountDone, contactDone: last.next.contactDone };
    }
    const output = { operation, database: databaseTarget.name, dryRun, complete, incomplete: !complete, continuation: complete ? null : cursors, ...total, matched: total.matched, deleted: total.deleted, blockedRules: last?.blockedRules ?? 0, legacyUnknown: last?.legacyUnknown ?? 0, rules: last?.rules ?? 0 };
    console.log(JSON.stringify(output));
    if (!complete) process.exitCode = 2;
    return;
  }
  const batchSize = Math.min(value("--batch-size", 50), 100);
  const maxBatches = value("--max-batches", 100);
  let cursors: { contactCursor?: string; exportCursor?: string; suppressionCursor?: string; contactDone?: boolean; exportDone?: boolean; suppressionDone?: boolean } = {};
  let total = { contacts: 0, exports: 0, suppressions: 0 };
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await runRetentionCleanup(prisma, actorId, now, { ...cursors, batchSize, dryRun });
    total = { contacts: total.contacts + result.contacts, exports: total.exports + result.exports, suppressions: total.suppressions + result.suppressions };
    if (dryRun || !result.next || (result.next.contactDone && result.next.exportDone && result.next.suppressionDone)) break;
    cursors = { contactCursor: result.next.contactCursor ?? undefined, exportCursor: result.next.exportCursor ?? undefined, suppressionCursor: result.next.suppressionCursor ?? undefined, contactDone: result.next.contactDone, exportDone: result.next.exportDone, suppressionDone: result.next.suppressionDone };
  }
  const complete = cursors.contactDone === true && cursors.exportDone === true && cursors.suppressionDone === true;
  console.log(JSON.stringify({ operation, database: databaseTarget.name, dryRun, complete, incomplete: !complete, continuation: complete ? null : cursors, ...total }));
  if (!complete) process.exitCode = 2;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "maintenance failed"); process.exitCode = 1; });

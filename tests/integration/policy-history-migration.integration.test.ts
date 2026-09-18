import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { assertRestrictedTestRole, parseTestDatabaseConfig } from "../helpers/test-database";

const database = parseTestDatabaseConfig();
const migrations = [
  "20260917230000_init/migration.sql",
  "20260918120000_contact_review/migration.sql",
  "20260918150000_policy_snapshots/migration.sql",
  "20260918180000_account_workspace/migration.sql",
  "20260918190000_account_workspace_version/migration.sql",
  "20260918200000_account_links/migration.sql",
  "20260918210000_account_link_evidence_history/migration.sql",
  "20260918220000_t07_export_suppression_deletion/migration.sql",
].map((relative) => readFileSync(path.join(process.cwd(), "prisma/migrations", relative), "utf8"));
const schemaName = `policy_migration_${database.runId}_${randomUUID().replaceAll("-", "")}`;
const sourceId = randomUUID();
const accountId = randomUUID();
let client: pg.Client | undefined;

function identifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

describe("R04 policy snapshot incremental migration", () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await assertRestrictedTestRole(client, database.databaseName);
    await client.query(`CREATE SCHEMA ${identifier(schemaName)}`);
    await client.query(`SET search_path TO ${identifier(schemaName)}`);
    await client.query(migrations[0]);
    await client.query(migrations[1]);
    await client.query(
      `INSERT INTO "Source" ("id", "name", "type", "status", "permissionNote", "allowImport", "allowExtract", "allowEvidenceText", "policyVersion", "retentionDays", "createdAt", "updatedAt")
       VALUES ($1, 'legacy source', 'DEMO', 'APPROVED', 'old authorization', true, true, true, 3, 30, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [sourceId],
    );
    await client.query(
      `INSERT INTO "Account" ("id", "platform", "nativeId", "displayName", "profileUrl", "normalizedProfileUrl", "sourceId", "sourceUrl", "capturedAt", "createdAt", "updatedAt")
       VALUES ($1, 'X', 'legacy-account', 'legacy account', 'https://example.com/demo/legacy', 'https://example.com/demo/legacy', $2, 'https://example.com/demo/source', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [accountId, sourceId],
    );
    await client.query(
      `INSERT INTO "Evidence" ("id", "accountId", "sourceId", "policyVersion", "sourceUrl", "capturedAt", "fieldLocation", "excerpt")
       VALUES ($1, $2, $3, 2, 'https://example.com/demo/evidence', CURRENT_TIMESTAMP, 'legacy field', 'legacy evidence')`,
      [randomUUID(), accountId, sourceId],
    );
    await client.query(migrations[2]);
    await client.query(migrations[3]);
    await client.query(migrations[4]);
    await client.query(migrations[5]);
    await client.query(migrations[6]);
    await client.query(migrations[7]);
  }, 30_000);

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${identifier(schemaName)} CASCADE`);
    await client.end();
  }, 30_000);

  it("旧 Source 版本和旧 Evidence 版本均保留为明确未知快照", async () => {
    const snapshots = await client!.query(
      `SELECT "version", "status", "allowExtract", "authorizationBasis", "isLegacy"
       FROM "SourcePolicySnapshot" WHERE "sourceId" = $1 ORDER BY "version"`,
      [sourceId],
    );
    expect(snapshots.rows).toEqual([
      {
        version: 2,
        status: null,
        allowExtract: null,
        authorizationBasis: "legacy/unknown: 迁移前没有策略快照，不能还原历史授权",
        isLegacy: true,
      },
      {
        version: 3,
        status: null,
        allowExtract: null,
        authorizationBasis: "legacy/unknown: 迁移前没有策略快照，不能还原历史授权",
        isLegacy: true,
      },
    ]);
    const evidence = await client!.query(
      `SELECT e."policyVersion", e."policySnapshotId", s."version", s."isLegacy"
       FROM "Evidence" e JOIN "SourcePolicySnapshot" s ON s."id" = e."policySnapshotId"
       WHERE e."accountId" = $1`,
      [accountId],
    );
    expect(evidence.rows).toEqual([{ policyVersion: 2, policySnapshotId: expect.any(String), version: 2, isLegacy: true }]);
    const workspace = await client!.query(
      `SELECT a."workspaceVersion", f."status", f."note"
       FROM "Account" a JOIN "AccountFollowUp" f ON f."accountId" = a."id"
       WHERE a."id" = $1`,
      [accountId],
    );
    expect(workspace.rows).toEqual([{ workspaceVersion: 1, status: "NOT_CONTACTED", note: "" }]);
    const linkTables = await client!.query(`SELECT (SELECT COUNT(*) FROM "AccountLinkEvidence") AS evidence_rows, (SELECT COUNT(*) FROM "AccountLinkDecision") AS decision_rows`);
    expect(linkTables.rows).toEqual([{ evidence_rows: "0", decision_rows: "0" }]);
    const t07Tables = await client!.query(`SELECT (SELECT COUNT(*) FROM "ContactSuppression") AS suppression_rows, (SELECT COUNT(*) FROM "ExportJob") AS export_rows, (SELECT COUNT(*) FROM "DeletionRequest") AS deletion_rows`);
    expect(t07Tables.rows).toEqual([{ suppression_rows: "0", export_rows: "0", deletion_rows: "0" }]);
  });
});

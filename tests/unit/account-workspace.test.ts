import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { accountWorkspaceDto, findUsableAccountIds, type AccountWorkspaceRecord } from "../../src/lib/account-workspace";

describe("account workspace query and DTO boundaries", () => {
  it("returns an empty set without querying when the account scope is empty", async () => {
    const query = vi.fn();
    const db = { $queryRaw: query } as unknown as PrismaClient;
    await expect(findUsableAccountIds(db, [])).resolves.toEqual(new Set<string>());
    expect(query).not.toHaveBeenCalled();
  });

  it("masks free-text notes for viewers and uses an explicit response allowlist", () => {
    const now = new Date("2026-09-18T00:00:00.000Z");
    const record = {
      id: "account-id",
      platform: "X",
      nativeId: "native-id",
      displayName: "示例账号",
      normalizedProfileUrl: "https://example.com/demo/x/example",
      organization: "示例机构",
      serviceTags: ["财富规划"],
      region: "上海",
      profileUrl: "https://example.com/demo/x/example",
      sourceId: "source-id",
      sourceUrl: "https://example.com/demo/source",
      capturedAt: now,
      createdAt: now,
      updatedAt: now,
      isDemo: true,
      ownerId: null,
      workspaceVersion: 1,
      source: { id: "source-id", name: "隔离来源", type: "DEMO", status: "APPROVED", allowImport: true, expiresAt: null },
      owner: null,
      favorites: [],
      followUp: { status: "CONTACTING", note: "sentinel@example.com wechat-sentinel phone-sentinel", updatedAt: now, updatedById: "admin-id" },
      evidence: [],
    } satisfies AccountWorkspaceRecord;

    const viewer = accountWorkspaceDto(record, { id: "viewer-id", role: "VIEWER" }, false);
    expect(viewer.followUp).toMatchObject({ status: "CONTACTING", note: null, noteMasked: true });
    expect(JSON.stringify(viewer)).not.toContain("sentinel@example.com");
    expect(viewer.source).not.toHaveProperty("permissionNote");

    const reviewer = accountWorkspaceDto(record, { id: "reviewer-id", role: "REVIEWER" }, false);
    expect(reviewer.followUp).toMatchObject({ note: "sentinel@example.com wechat-sentinel phone-sentinel", noteMasked: false });
  });
});

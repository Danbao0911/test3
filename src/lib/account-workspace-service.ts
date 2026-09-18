import { Prisma } from "@/generated/prisma/client";
import type { PrismaClient } from "@/generated/prisma/client";

export type WorkspaceFollowUpInput = {
  status: "NOT_CONTACTED" | "CONTACTING" | "REPLIED" | "NOT_MATCH" | "DO_NOT_CONTACT";
  note: string;
  confirmReactivation?: boolean;
};

export type WorkspaceUpdateInput = {
  accountId: string;
  userId: string;
  expectedWorkspaceVersion: number;
  ownerId?: string | null;
  followUp?: WorkspaceFollowUpInput;
  failAfterOwner?: boolean;
};

export class WorkspaceServiceError extends Error {
  constructor(public readonly code: "ACCOUNT_NOT_FOUND" | "OWNER_NOT_FOUND" | "WORKSPACE_CONFLICT" | "REACTIVATION_CONFIRMATION_REQUIRED" | "TEST_WORKSPACE_FAILURE", message: string) {
    super(message);
  }
}

async function lockAccount(tx: Prisma.TransactionClient, accountId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${accountId}::uuid FOR UPDATE`;
  const account = await tx.account.findUnique({
    where: { id: accountId },
    select: { id: true, ownerId: true, workspaceVersion: true, followUp: { select: { status: true, note: true } } },
  });
  if (!account) throw new WorkspaceServiceError("ACCOUNT_NOT_FOUND", "账号不存在");
  return account;
}

export async function updateAccountWorkspace(db: PrismaClient, input: WorkspaceUpdateInput) {
  return db.$transaction(async (tx) => {
    const current = await lockAccount(tx, input.accountId);
    if (current.workspaceVersion !== input.expectedWorkspaceVersion) {
      throw new WorkspaceServiceError("WORKSPACE_CONFLICT", "工作台已被其他用户更新，请刷新后重新核对");
    }

    const ownerChanged = input.ownerId !== undefined && input.ownerId !== current.ownerId;
    const followUpChanged = input.followUp !== undefined && (
      input.followUp.status !== (current.followUp?.status ?? "NOT_CONTACTED") ||
      input.followUp.note !== (current.followUp?.note ?? "")
    );

    if (!ownerChanged && !followUpChanged) return { changed: false, workspaceVersion: current.workspaceVersion };

    if (input.ownerId !== undefined && input.ownerId !== null) {
      const owner = await tx.user.findUnique({ where: { id: input.ownerId }, select: { id: true } });
      if (!owner) throw new WorkspaceServiceError("OWNER_NOT_FOUND", "负责人不存在");
    }

    if (followUpChanged && current.followUp?.status === "DO_NOT_CONTACT" && input.followUp?.status !== "DO_NOT_CONTACT" &&
      (!input.followUp?.confirmReactivation || input.followUp.note.trim() === "")) {
      throw new WorkspaceServiceError("REACTIVATION_CONFIRMATION_REQUIRED", "从不再联系恢复前必须二次确认并填写理由");
    }

    const nextVersion = current.workspaceVersion + 1;
    if (ownerChanged) {
      await tx.account.update({ where: { id: input.accountId }, data: { ownerId: input.ownerId, workspaceVersion: nextVersion } });
      await tx.auditEvent.create({ data: { actorId: input.userId, action: "ACCOUNT_OWNER_CHANGED", targetId: input.accountId } });
      if (input.failAfterOwner) throw new WorkspaceServiceError("TEST_WORKSPACE_FAILURE", "测试注入：负责人更新后失败");
    } else {
      await tx.account.update({ where: { id: input.accountId }, data: { workspaceVersion: nextVersion } });
    }

    if (followUpChanged && input.followUp) {
      await tx.accountFollowUp.upsert({
        where: { accountId: input.accountId },
        create: { accountId: input.accountId, status: input.followUp.status, note: input.followUp.note, updatedById: input.userId },
        update: { status: input.followUp.status, note: input.followUp.note, updatedById: input.userId },
      });
      await tx.auditEvent.create({ data: { actorId: input.userId, action: "ACCOUNT_FOLLOWUP_UPDATED", targetId: input.accountId } });
    }
    return { changed: true, workspaceVersion: nextVersion };
  });
}

export async function setAccountFavorite(db: PrismaClient, accountId: string, userId: string, favorite: boolean) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${accountId}::uuid FOR UPDATE`;
    const account = await tx.account.findUnique({ where: { id: accountId }, select: { id: true } });
    if (!account) throw new WorkspaceServiceError("ACCOUNT_NOT_FOUND", "账号不存在");
    const existing = await tx.accountFavorite.findUnique({ where: { accountId_userId: { accountId, userId } }, select: { id: true } });
    if (favorite && !existing) {
      await tx.accountFavorite.create({ data: { accountId, userId } });
      await tx.auditEvent.create({ data: { actorId: userId, action: "ACCOUNT_FAVORITED", targetId: accountId } });
      return { favorite: true, changed: true };
    }
    if (!favorite && existing) {
      await tx.accountFavorite.delete({ where: { id: existing.id } });
      await tx.auditEvent.create({ data: { actorId: userId, action: "ACCOUNT_UNFAVORITED", targetId: accountId } });
      return { favorite: false, changed: true };
    }
    return { favorite, changed: false };
  });
}

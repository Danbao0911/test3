import { NextResponse } from "next/server";
import { canMaintain } from "@/lib/permissions";
import { Prisma } from "@/generated/prisma/client";
import type { Platform } from "@/generated/prisma/client";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { normalizeProfileUrl, normalizeSourceUrl, UrlValidationError } from "@/lib/account-normalizer";
import { accountWorkspaceDto, accountWorkspaceInclude, findUsableAccountIds, findWorkspaceAccountPage } from "@/lib/account-workspace";
import { prisma } from "@/lib/db";
import { createAccountWithRules, SourceNotAllowedError } from "@/lib/import-service";
import { accountInputSchema, followUpStatusValues, platformValues, parsePositiveInt, uuidSchema, validationMessage } from "@/lib/validation";

export const runtime = "nodejs";

function dbConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const platformParam = url.searchParams.get("platform");
  const platform = platformValues.includes(platformParam as (typeof platformValues)[number]) ? platformParam as Platform : undefined;
  const serviceTag = url.searchParams.get("serviceTag")?.trim() || undefined;
  const sourceId = url.searchParams.get("sourceId")?.trim() || undefined;
  const contactStatusParam = url.searchParams.get("contactStatus")?.trim() || undefined;
  const hasContactParam = url.searchParams.get("hasContact")?.trim() || undefined;
  const followUpStatusParam = url.searchParams.get("followUpStatus")?.trim() || undefined;
  const favoriteParam = url.searchParams.get("favorite")?.trim() || undefined;
  const validContactStatuses = ["PENDING", "APPROVED", "REJECTED", "INVALID"] as const;
  if ((contactStatusParam && !validContactStatuses.includes(contactStatusParam as (typeof validContactStatuses)[number])) ||
      (hasContactParam && !["YES", "NO"].includes(hasContactParam)) ||
      (followUpStatusParam && !followUpStatusValues.includes(followUpStatusParam as (typeof followUpStatusValues)[number])) ||
      (favoriteParam && !["YES", "NO"].includes(favoriteParam)) ||
      (sourceId && !uuidSchema.safeParse(sourceId).success)) {
    return NextResponse.json({ error: "VALIDATION_ERROR", message: "账号工作台筛选条件无效" }, { status: 422 });
  }
  const page = parsePositiveInt(url.searchParams.get("page"), 1, 1_000_000);
  const pageSize = parsePositiveInt(url.searchParams.get("pageSize"), 20, 100);
  const result = await findWorkspaceAccountPage(prisma, user.id, {
    q,
    platform,
    serviceTag,
    sourceId,
    contactStatus: contactStatusParam,
    hasContact: hasContactParam as "YES" | "NO" | undefined,
    followUpStatus: followUpStatusParam,
    favorite: favoriteParam as "YES" | "NO" | undefined,
  }, page, pageSize);
  if (result.ids.length === 0) return NextResponse.json({ items: [], total: result.total, page, pageSize });
  const items = await prisma.account.findMany({
    where: { id: { in: result.ids } },
    include: { ...accountWorkspaceInclude(user.id), source: { select: { id: true, name: true, status: true, type: true, allowImport: true, expiresAt: true } } },
  });
  const itemById = new Map(items.map((item) => [item.id, item]));
  const orderedItems = result.ids.flatMap((id) => { const item = itemById.get(id); return item ? [item] : []; });
  const usableIds = hasContactParam === "YES" ? new Set(result.ids) : hasContactParam === "NO" ? new Set<string>() : await findUsableAccountIds(prisma, result.ids);
  return NextResponse.json({ items: orderedItems.map((item) => accountWorkspaceDto(item, user, usableIds.has(item.id))), total: result.total, page, pageSize });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!isSameOrigin(request)) return forbidden("请求来源校验失败");
  if (!canMaintain(user.role)) return forbidden("当前角色无此操作权限");
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "INVALID_JSON", message: "请求格式错误" }, { status: 400 }); }
  const parsed = accountInputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", message: validationMessage(parsed.error) }, { status: 422 });
  const input = parsed.data;
  let normalizedProfileUrl: string;
  let normalizedSourceUrl: string;
  try {
    normalizedProfileUrl = normalizeProfileUrl(input.platform, input.profileUrl);
    normalizedSourceUrl = normalizeSourceUrl(input.sourceUrl);
  } catch (error) {
    const urlError = error instanceof UrlValidationError ? error : new Error("链接校验失败");
    return NextResponse.json({ error: error instanceof UrlValidationError ? error.code : "URL_ERROR", message: urlError.message }, { status: 422 });
  }
  try {
    const result = await createAccountWithRules(prisma, input, normalizedProfileUrl, normalizedSourceUrl);
    if (result.kind === "conflict") return NextResponse.json({ error: "IDENTITY_CONFLICT", message: "平台身份 ID 和主页链接分别命中不同账号，未自动合并" }, { status: 409 });
    if (result.kind === "duplicate") return NextResponse.json({ error: "DUPLICATE", message: "账号已存在", existingAccountId: result.existingAccountId }, { status: 409 });
    const account = await prisma.account.findUnique({ where: { id: result.account.id }, include: { source: true } });
    return NextResponse.json({ item: account }, { status: 201 });
  } catch (error) {
    if (error instanceof SourceNotAllowedError) return NextResponse.json({ error: error.code, message: error.message }, { status: error.code === "SOURCE_NOT_FOUND" ? 422 : error.code === "IDENTITY_DELETION_BLOCKED" ? 409 : 403 });
    if (dbConflict(error)) return NextResponse.json({ error: "DUPLICATE", message: "账号已存在，请刷新后重试" }, { status: 409 });
    return NextResponse.json({ error: "DATABASE_ERROR", message: "账号保存失败，请稍后重试" }, { status: 500 });
  }
}

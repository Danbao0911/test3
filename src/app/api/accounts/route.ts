import { NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import type { Platform } from "@/generated/prisma/client";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { normalizeProfileUrl, normalizeSourceUrl, UrlValidationError } from "@/lib/account-normalizer";
import { prisma } from "@/lib/db";
import { sourceBlockMessage, sourceCanImport } from "@/lib/import-service";
import { accountInputSchema, platformValues, parsePositiveInt, validationMessage } from "@/lib/validation";

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
  const page = parsePositiveInt(url.searchParams.get("page"), 1, 1_000_000);
  const pageSize = parsePositiveInt(url.searchParams.get("pageSize"), 20, 100);
  const where: Prisma.AccountWhereInput = {
    ...(q ? { OR: [{ displayName: { contains: q, mode: "insensitive" } }, { organization: { contains: q, mode: "insensitive" } }] } : {}),
    ...(platform ? { platform } : {}),
    ...(serviceTag ? { serviceTags: { has: serviceTag } } : {}),
    ...(sourceId ? { sourceId } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.account.findMany({
      where,
      include: { source: { select: { id: true, name: true, status: true, type: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.account.count({ where }),
  ]);
  return NextResponse.json({ items, total, page, pageSize });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!isSameOrigin(request)) return forbidden("请求来源校验失败");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON", message: "请求格式错误" }, { status: 400 });
  }
  const parsed = accountInputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", message: validationMessage(parsed.error) }, { status: 422 });
  const input = parsed.data;
  const source = await prisma.source.findUnique({ where: { id: input.sourceId } });
  if (!source) return NextResponse.json({ error: "SOURCE_NOT_FOUND", message: "来源不存在" }, { status: 422 });
  if (!sourceCanImport(source)) return NextResponse.json({ error: "SOURCE_NOT_ALLOWED", message: sourceBlockMessage(source) }, { status: 403 });
  let normalizedProfileUrl: string;
  let normalizedSourceUrl: string;
  try {
    normalizedProfileUrl = normalizeProfileUrl(input.platform, input.profileUrl);
    normalizedSourceUrl = normalizeSourceUrl(input.sourceUrl);
  } catch (error) {
    const urlError = error instanceof UrlValidationError ? error : new Error("链接校验失败");
    return NextResponse.json({ error: error instanceof UrlValidationError ? error.code : "URL_ERROR", message: urlError.message }, { status: 422 });
  }
  const byNativeId = input.nativeId
    ? await prisma.account.findUnique({ where: { platform_nativeId: { platform: input.platform, nativeId: input.nativeId } } })
    : null;
  const byUrl = await prisma.account.findUnique({ where: { platform_normalizedProfileUrl: { platform: input.platform, normalizedProfileUrl } } });
  if (byNativeId && byUrl && byNativeId.id !== byUrl.id) {
    return NextResponse.json({ error: "IDENTITY_CONFLICT", message: "平台身份 ID 和主页链接分别命中不同账号，未自动合并" }, { status: 409 });
  }
  const existing = byNativeId ?? byUrl;
  if (existing) return NextResponse.json({ error: "DUPLICATE", message: "账号已存在", existingAccountId: existing.id }, { status: 409 });
  try {
    const account = await prisma.account.create({
      data: {
        platform: input.platform,
        nativeId: input.nativeId,
        displayName: input.displayName,
        profileUrl: input.profileUrl.trim(),
        normalizedProfileUrl,
        organization: input.organization,
        serviceTags: input.serviceTags,
        region: input.region,
        sourceId: input.sourceId,
        sourceUrl: normalizedSourceUrl,
        capturedAt: new Date(),
        isDemo: source.type === "DEMO",
      },
      include: { source: true },
    });
    return NextResponse.json({ item: account }, { status: 201 });
  } catch (error) {
    if (dbConflict(error)) return NextResponse.json({ error: "DUPLICATE", message: "账号已存在，请刷新后重试" }, { status: 409 });
    throw error;
  }
}

import { NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import type { Platform } from "@/generated/prisma/client";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { normalizeProfileUrl, normalizeSourceUrl, UrlValidationError } from "@/lib/account-normalizer";
import { prisma } from "@/lib/db";
import { createAccountWithRules, SourceNotAllowedError } from "@/lib/import-service";
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
    prisma.account.findMany({ where, include: { source: { select: { id: true, name: true, status: true, type: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
    prisma.account.count({ where }),
  ]);
  return NextResponse.json({ items, total, page, pageSize });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!isSameOrigin(request)) return forbidden("请求来源校验失败");
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
    if (error instanceof SourceNotAllowedError) return NextResponse.json({ error: error.code, message: error.message }, { status: error.code === "SOURCE_NOT_FOUND" ? 422 : 403 });
    if (dbConflict(error)) return NextResponse.json({ error: "DUPLICATE", message: "账号已存在，请刷新后重试" }, { status: 409 });
    return NextResponse.json({ error: "DATABASE_ERROR", message: "账号保存失败，请稍后重试" }, { status: 500 });
  }
}

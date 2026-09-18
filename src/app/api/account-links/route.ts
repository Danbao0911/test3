import { NextResponse } from "next/server";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { canMaintain } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { accountLinkCreateSchema, parsePositiveInt, uuidSchema } from "@/lib/validation";
import { accountLinkDto, createAccountLink, evaluateAccountLink, listAccountLinks } from "@/lib/account-link-service";
import { accountLinkErrorResponse, readAccountLinkJson } from "@/lib/account-link-http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const url = new URL(request.url);
  const accountId = url.searchParams.get("accountId") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const page = parsePositiveInt(url.searchParams.get("page"), 1, 10_000);
  const pageSize = parsePositiveInt(url.searchParams.get("pageSize"), 50, 50);
  if (accountId && !uuidSchema.safeParse(accountId).success) return NextResponse.json({ error: "VALIDATION_ERROR", message: "账号筛选条件无效" }, { status: 422 });
  if (status && !["PENDING", "CONFIRMED", "REVOKED"].includes(status)) return NextResponse.json({ error: "VALIDATION_ERROR", message: "关联状态无效" }, { status: 422 });
  try {
    const result = await listAccountLinks(prisma, { accountId, status: status as "PENDING" | "CONFIRMED" | "REVOKED" | undefined, page, pageSize });
    const items = await Promise.all(result.items.map(async (item) => accountLinkDto(item, user.role, await evaluateAccountLink(prisma, item.id))));
    return NextResponse.json({ items, total: result.total, page: result.page, pageSize: result.pageSize, hasMore: result.hasMore }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return accountLinkErrorResponse(error); }
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!canMaintain(user.role) || !isSameOrigin(request)) return forbidden("当前角色无账号关联操作权限");
  try {
    const parsed = accountLinkCreateSchema.safeParse(await readAccountLinkJson(request));
    if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", message: "账号关联候选字段格式错误" }, { status: 422 });
    const result = await createAccountLink(prisma, user.id, parsed.data);
    return NextResponse.json({ item: accountLinkDto(result.item, user.role, await evaluateAccountLink(prisma, result.item.id)) }, { status: result.created ? 201 : 200 });
  } catch (error) { return accountLinkErrorResponse(error); }
}

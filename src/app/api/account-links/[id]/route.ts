import { NextResponse } from "next/server";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { canMaintain } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { accountLinkReviewSchema, uuidSchema } from "@/lib/validation";
import { accountLinkDto, accountLinkInclude, reviewAccountLink } from "@/lib/account-link-service";
import { accountLinkErrorResponse, readAccountLinkJson } from "@/lib/account-link-http";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: "LINK_NOT_FOUND", message: "账号关联不存在" }, { status: 404 });
  try {
    const item = await prisma.accountLink.findUnique({ where: { id }, include: accountLinkInclude });
    if (!item) return NextResponse.json({ error: "LINK_NOT_FOUND", message: "账号关联不存在" }, { status: 404 });
    return NextResponse.json({ item: accountLinkDto(item, user.role) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return accountLinkErrorResponse(error); }
}

export async function PATCH(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!canMaintain(user.role) || !isSameOrigin(request)) return forbidden("当前角色无账号关联操作权限");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: "LINK_NOT_FOUND", message: "账号关联不存在" }, { status: 404 });
  try {
    const parsed = accountLinkReviewSchema.safeParse(await readAccountLinkJson(request));
    if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", message: "审核需要当前版本、决定和非空原因" }, { status: 422 });
    const item = await reviewAccountLink(prisma, user.id, id, parsed.data);
    return NextResponse.json({ item: accountLinkDto(item, user.role) });
  } catch (error) { return accountLinkErrorResponse(error); }
}

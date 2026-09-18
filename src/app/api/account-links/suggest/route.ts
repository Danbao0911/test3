import { NextResponse } from "next/server";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { canMaintain } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { accountLinkSuggestionSchema } from "@/lib/validation";
import { accountLinkDto, suggestAccountLinksForContact } from "@/lib/account-link-service";
import { accountLinkErrorResponse, readAccountLinkJson } from "@/lib/account-link-http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!canMaintain(user.role) || !isSameOrigin(request)) return forbidden("当前角色无账号关联操作权限");
  try {
    const parsed = accountLinkSuggestionSchema.safeParse(await readAccountLinkJson(request));
    if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", message: "联系项候选字段格式错误" }, { status: 422 });
    const items = await suggestAccountLinksForContact(prisma, user.id, parsed.data.contactId);
    return NextResponse.json({ items: items.map((item) => accountLinkDto(item, user.role)) }, { status: 201 });
  } catch (error) { return accountLinkErrorResponse(error); }
}

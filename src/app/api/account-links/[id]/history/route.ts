import { NextResponse } from "next/server";
import { getCurrentUser, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { uuidSchema } from "@/lib/validation";
import { listAccountLinkHistory } from "@/lib/account-link-service";
import { accountLinkErrorResponse } from "@/lib/account-link-http";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: "LINK_NOT_FOUND", message: "账号关联不存在" }, { status: 404 });
  try {
    const item = await prisma.accountLink.findUnique({ where: { id }, select: { id: true } });
    if (!item) return NextResponse.json({ error: "LINK_NOT_FOUND", message: "账号关联不存在" }, { status: 404 });
    return NextResponse.json({ items: await listAccountLinkHistory(prisma, id, user.role) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return accountLinkErrorResponse(error); }
}

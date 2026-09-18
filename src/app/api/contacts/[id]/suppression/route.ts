import { NextResponse } from "next/server";
import { canMaintain } from "@/lib/permissions";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { readContactJson, contactErrorResponse } from "@/lib/contact-http";
import { suppressionSchema } from "@/lib/validation";
import { RetentionError, suppressContact } from "@/lib/retention-service";
import { uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!canMaintain(user.role) || !isSameOrigin(request)) return forbidden();
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: "NOT_FOUND", message: "联系项不存在" }, { status: 404 });
  try {
    const parsed = suppressionSchema.safeParse(await readContactJson(request));
    if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", message: "拒绝联系需要原因、处理依据和有效期限" }, { status: 422 });
    return NextResponse.json({ item: await suppressContact(prisma, user.id, id, parsed.data) });
  } catch (error) {
    if (error instanceof RetentionError) return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    return contactErrorResponse(error);
  }
}

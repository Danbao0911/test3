import { NextResponse } from "next/server";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { canMaintain } from "@/lib/permissions";
import { contactDto, contactInclude, reviewContact } from "@/lib/contact-service";
import { contactErrorResponse, readContactJson } from "@/lib/contact-http";
import { reviewSchema } from "@/lib/contact-validation";
import { uuidSchema } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };
const missing = () => NextResponse.json({ error: "NOT_FOUND", message: "联系项不存在" }, { status: 404 });

export async function GET(_request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return missing();
  try {
    const item = await prisma.contactPoint.findUnique({ where: { id }, include: contactInclude });
    if (!item) return missing();
    return NextResponse.json({ item: contactDto(item, user.role) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return contactErrorResponse(error); }
}

export async function PATCH(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!canMaintain(user.role) || !isSameOrigin(request)) return forbidden();
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return missing();
  try {
    const parsed = reviewSchema.safeParse(await readContactJson(request));
    if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", message: "审核需要当前版本、决定、归属/商务用途确认及非空原因" }, { status: 422 });
    return NextResponse.json({ item: await reviewContact(prisma, user.id, id, parsed.data) });
  } catch (error) { return contactErrorResponse(error); }
}

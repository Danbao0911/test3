import { NextResponse } from "next/server";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { canMaintain } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { extractionSchema } from "@/lib/contact-validation";
import { extractForAccount } from "@/lib/contact-service";
import { contactErrorResponse, readContactJson } from "@/lib/contact-http";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!canMaintain(user.role) || !isSameOrigin(request)) return forbidden();
  try {
    const parsed = extractionSchema.safeParse(await readContactJson(request));
    if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", message: "请填写有效账号、来源、取得时间、字段位置及最多 5000 字的文本" }, { status: 422 });
    return NextResponse.json(await extractForAccount(prisma, user.id, parsed.data));
  } catch (error) { return contactErrorResponse(error); }
}

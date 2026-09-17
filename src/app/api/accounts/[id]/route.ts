import { NextResponse } from "next/server";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { accountPatchSchema, uuidSchema, validationMessage } from "@/lib/validation";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: "NOT_FOUND", message: "账号不存在" }, { status: 404 });
  const account = await prisma.account.findUnique({
    where: { id },
    include: { source: true },
  });
  if (!account) return NextResponse.json({ error: "NOT_FOUND", message: "账号不存在" }, { status: 404 });
  return NextResponse.json({ item: account });
}

export async function PATCH(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!isSameOrigin(request)) return forbidden("请求来源校验失败");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: "NOT_FOUND", message: "账号不存在" }, { status: 404 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON", message: "请求格式错误" }, { status: 400 });
  }
  const parsed = accountPatchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", message: validationMessage(parsed.error) }, { status: 422 });
  const current = await prisma.account.findUnique({ where: { id } });
  if (!current) return NextResponse.json({ error: "NOT_FOUND", message: "账号不存在" }, { status: 404 });
  const account = await prisma.account.update({ where: { id }, data: parsed.data, include: { source: true } });
  return NextResponse.json({ item: account });
}

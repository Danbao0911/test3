import { NextResponse } from "next/server";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { sourcePatchSchema, validationMessage } from "@/lib/validation";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const source = await prisma.source.findUnique({ where: { id } });
  if (!source) return NextResponse.json({ error: "NOT_FOUND", message: "来源不存在" }, { status: 404 });
  return NextResponse.json({ item: source });
}

export async function PATCH(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!isSameOrigin(request)) return forbidden("请求来源校验失败");
  const { id } = await params;
  const current = await prisma.source.findUnique({ where: { id } });
  if (!current) return NextResponse.json({ error: "NOT_FOUND", message: "来源不存在" }, { status: 404 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON", message: "请求格式错误" }, { status: 400 });
  }
  const parsed = sourcePatchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", message: validationMessage(parsed.error) }, { status: 422 });
  const nextStatus = parsed.data.status ?? current.status;
  const nextNote = parsed.data.permissionNote ?? current.permissionNote;
  if (nextStatus === "APPROVED" && !nextNote.trim()) {
    return NextResponse.json({ error: "PERMISSION_NOTE_REQUIRED", message: "批准来源前必须填写录入依据" }, { status: 422 });
  }
  const source = await prisma.source.update({
    where: { id },
    data: {
      permissionNote: parsed.data.permissionNote,
      status: nextStatus,
      allowImport: nextStatus === "APPROVED" ? parsed.data.allowImport ?? current.allowImport : false,
      expiresAt: parsed.data.expiresAt === undefined ? undefined : parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
    },
  });
  return NextResponse.json({ item: source });
}

import { NextResponse } from "next/server";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { sourcePatchSchema, uuidSchema, validationMessage } from "@/lib/validation";
import { sourceTypeAllowed, RUNTIME_MODE } from "@/lib/runtime-config";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: "NOT_FOUND", message: "来源不存在" }, { status: 404 });
  const source = await prisma.source.findUnique({ where: { id } });
  if (!source) return NextResponse.json({ error: "NOT_FOUND", message: "来源不存在" }, { status: 404 });
  return NextResponse.json({ item: source });
}

export async function PATCH(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!isSameOrigin(request)) return forbidden("请求来源校验失败");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: "NOT_FOUND", message: "来源不存在" }, { status: 404 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "INVALID_JSON", message: "请求格式错误" }, { status: 400 }); }
  const parsed = sourcePatchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", message: validationMessage(parsed.error) }, { status: 422 });
  try {
    const source = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; type: "DEMO" | "AUTHORIZED_MANUAL"; status: "DRAFT" | "APPROVED" | "REVOKED"; permissionNote: string; allowImport: boolean; expiresAt: Date | null }>>`
        SELECT "id", "type", "status", "permissionNote", "allowImport", "expiresAt" FROM "Source" WHERE "id" = ${id}::uuid FOR UPDATE
      `;
      const current = rows[0];
      if (!current) throw new Error("SOURCE_NOT_FOUND");
      if (!sourceTypeAllowed(current.type)) throw new Error("SOURCE_TYPE_NOT_ALLOWED");
      const nextStatus = parsed.data.status ?? current.status;
      const nextNote = parsed.data.permissionNote ?? current.permissionNote;
      if (nextStatus === "APPROVED" && !nextNote.trim()) throw new Error("PERMISSION_NOTE_REQUIRED");
      return tx.source.update({ where: { id }, data: { permissionNote: parsed.data.permissionNote, status: nextStatus, allowImport: nextStatus === "APPROVED" ? parsed.data.allowImport ?? current.allowImport : false, expiresAt: parsed.data.expiresAt === undefined ? undefined : parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null } });
    });
    return NextResponse.json({ item: source });
  } catch (error) {
    const message = error instanceof Error ? error.message : "来源更新失败";
    if (message === "SOURCE_NOT_FOUND") return NextResponse.json({ error: "NOT_FOUND", message: "来源不存在" }, { status: 404 });
    if (message === "SOURCE_TYPE_NOT_ALLOWED") return NextResponse.json({ error: "SOURCE_TYPE_NOT_ALLOWED", message: `${RUNTIME_MODE} 模式不能使用此来源类型` }, { status: 403 });
    if (message === "PERMISSION_NOTE_REQUIRED") return NextResponse.json({ error: message, message: "批准来源前必须填写录入依据" }, { status: 422 });
    return NextResponse.json({ error: "DATABASE_ERROR", message: "来源更新失败，请稍后重试" }, { status: 500 });
  }
}

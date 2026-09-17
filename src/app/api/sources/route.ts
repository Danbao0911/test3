import { NextResponse } from "next/server";
import { canManageSources } from "@/lib/permissions";
import { forbidden, isSameOrigin, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { sourceCreateSchema } from "@/lib/validation";
import { sourceTypeAllowed, RUNTIME_MODE } from "@/lib/runtime-config";

export const runtime = "nodejs";

export async function GET() {
  const user = await (await import("@/lib/auth")).getCurrentUser();
  if (!user) return unauthorized();
  const sources = await prisma.source.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  return NextResponse.json({ items: sources });
}

export async function POST(request: Request) {
  const user = await (await import("@/lib/auth")).getCurrentUser();
  if (!user) return unauthorized();
  if (!isSameOrigin(request)) return forbidden("请求来源校验失败");
  if (!canManageSources(user.role)) return forbidden("当前角色无此操作权限");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON", message: "请求格式错误" }, { status: 400 });
  }
  const parsed = sourceCreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", message: "来源字段格式错误" }, { status: 422 });
  if (!sourceTypeAllowed(parsed.data.type)) return NextResponse.json({ error: "SOURCE_TYPE_NOT_ALLOWED", message: `${RUNTIME_MODE} 模式不能创建 ${parsed.data.type} 来源` }, { status: 403 });
  const source = await prisma.source.create({
    data: {
      name: parsed.data.name,
      type: parsed.data.type,
      permissionNote: parsed.data.permissionNote,
      status: "DRAFT",
      allowImport: false,
    },
  });
  return NextResponse.json({ item: source }, { status: 201 });
}

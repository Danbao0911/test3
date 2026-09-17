import { NextResponse } from "next/server";
import { forbidden, isSameOrigin, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { sourceCreateSchema } from "@/lib/validation";

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
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON", message: "请求格式错误" }, { status: 400 });
  }
  const parsed = sourceCreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", message: "来源字段格式错误" }, { status: 422 });
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

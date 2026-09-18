import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser, forbidden, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { platformSourcePage } from "@/lib/platform-service";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (user.role !== "ADMIN") return forbidden();
  const query = new URL(request.url).searchParams;
  const parsed = z.object({ after: z.uuid().optional() }).strict().safeParse(Object.fromEntries(query));
  if (!parsed.success || query.getAll("after").length > 1) return NextResponse.json({ error: "VALIDATION_ERROR", message: "来源分页参数无效" }, { status: 422 });
  try {
    return NextResponse.json(await platformSourcePage(prisma, user, parsed.data.after), { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "DATABASE_ERROR", message: "来源加载失败，请稍后重试" }, { status: 500 });
  }
}

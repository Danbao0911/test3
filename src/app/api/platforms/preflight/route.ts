import { NextResponse } from "next/server";
import { getCurrentUser, forbidden, isSameOrigin, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { readBoundedJson, RequestJsonError } from "@/lib/request";
import { checkPlatformReadiness, PlatformPreflightError } from "@/lib/platform-service";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (user.role !== "ADMIN") return forbidden();
  if (!isSameOrigin(request)) return forbidden("请求来源校验失败");
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return NextResponse.json({ error: "INVALID_JSON", message: "需要 JSON 请求" }, { status: 400 });
  try {
    const body = await readBoundedJson(request, 4096);
    // 200 means the preflight ran, not that a platform operation succeeded.
    return NextResponse.json({ item: await checkPlatformReadiness(prisma, user, body) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof PlatformPreflightError) return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    if (error instanceof RequestJsonError) return NextResponse.json({ error: error.code, message: error.message }, { status: error.code === "REQUEST_TOO_LARGE" ? 413 : 400 });
    return NextResponse.json({ error: "DATABASE_ERROR", message: "接入条件核对失败，请稍后重试" }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { clearSessionCookie, deleteSession, isSameOrigin, SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "CSRF_ORIGIN", message: "请求来源校验失败" }, { status: 403 });
  }
  const token = request.headers.get("cookie")?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1];
  await deleteSession(token);
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
}

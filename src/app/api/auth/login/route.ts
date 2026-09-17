import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { createSession, isSameOrigin, setSessionCookie } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { loginSchema } from "@/lib/validation";

export const runtime = "nodejs";

const attempts = new Map<string, { count: number; resetAt: number }>();

function clientKey(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function isRateLimited(key: string) {
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + 5 * 60 * 1000 });
    return false;
  }
  current.count += 1;
  return current.count > 10;
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "CSRF_ORIGIN", message: "请求来源校验失败" }, { status: 403 });
  }
  const key = clientKey(request);
  if (isRateLimited(key)) {
    return NextResponse.json({ error: "RATE_LIMITED", message: "登录尝试过于频繁，请稍后再试" }, { status: 429 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON", message: "请求格式错误" }, { status: 400 });
  }
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "VALIDATION_ERROR", message: "邮箱或密码格式错误" }, { status: 422 });
  }
  const email = parsed.data.email.toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  const passwordMatches = user ? await bcrypt.compare(parsed.data.password, user.passwordHash) : false;
  if (!user || !passwordMatches) {
    return NextResponse.json({ error: "INVALID_CREDENTIALS", message: "邮箱或密码错误" }, { status: 401 });
  }
  const session = await createSession(user.id);
  const response = NextResponse.json({ user: { id: user.id, email: user.email } });
  setSessionCookie(response, session.token, session.expiresAt);
  return response;
}

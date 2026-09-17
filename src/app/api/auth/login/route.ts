import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { createSession, hashRateLimitKey, isSameOrigin, setSessionCookie } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { loginSchema } from "@/lib/validation";

export const runtime = "nodejs";

async function consumeAccountAttempt(email: string) {
  const keyHash = hashRateLimitKey(email);
  const now = new Date();
  const windowStart = new Date(now.getTime() - 5 * 60 * 1000);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`test3:login:${keyHash}`}))`;
    const current = await tx.loginThrottle.findUnique({ where: { keyHash } });
    if (!current || current.windowStartedAt <= windowStart) {
      await tx.loginThrottle.upsert({ where: { keyHash }, update: { attemptCount: 1, windowStartedAt: now }, create: { keyHash, attemptCount: 1, windowStartedAt: now } });
      return false;
    }
    if (current.attemptCount >= 10) return true;
    await tx.loginThrottle.update({ where: { keyHash }, data: { attemptCount: { increment: 1 } } });
    return false;
  });
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "CSRF_ORIGIN", message: "请求来源校验失败" }, { status: 403 });
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
  try {
    if (await consumeAccountAttempt(email)) return NextResponse.json({ error: "RATE_LIMITED", message: "登录尝试过于频繁，请稍后再试" }, { status: 429 });
    const user = await prisma.user.findUnique({ where: { email } });
    const passwordMatches = user ? await bcrypt.compare(parsed.data.password, user.passwordHash) : false;
    if (!user || !passwordMatches) {
      return NextResponse.json({ error: "INVALID_CREDENTIALS", message: "邮箱或密码错误" }, { status: 401 });
    }
    const session = await createSession(user.id);
    const response = NextResponse.json({ user: { id: user.id, email: user.email } });
    setSessionCookie(response, session.token, session.expiresAt);
    return response;
  } catch (error) {
    console.error("[auth-login-database-error]", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "DATABASE_ERROR", message: "登录服务暂不可用，请稍后重试" }, { status: 503 });
  }
}

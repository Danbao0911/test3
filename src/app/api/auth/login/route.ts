import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { createSession, hashRateLimitKey, isSameOrigin, setSessionCookie } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { loginSchema } from "@/lib/validation";

export const runtime = "nodejs";

async function accountIsLocked(email: string) {
  const keyHash = hashRateLimitKey(email);
  const now = new Date();
  const windowStart = new Date(now.getTime() - 5 * 60 * 1000);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`test3:login:${keyHash}`}))::text AS locked`;
    const current = await tx.loginThrottle.findUnique({ where: { keyHash } });
    return Boolean(current && current.windowStartedAt > windowStart && current.attemptCount >= 10);
  });
}

async function recordFailedAttempt(email: string) {
  const keyHash = hashRateLimitKey(email);
  const now = new Date();
  const windowStart = new Date(now.getTime() - 5 * 60 * 1000);
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`test3:login:${keyHash}`}))::text AS locked`;
    const current = await tx.loginThrottle.findUnique({ where: { keyHash } });
    if (!current || current.windowStartedAt <= windowStart) {
      await tx.loginThrottle.upsert({ where: { keyHash }, update: { attemptCount: 1, windowStartedAt: now }, create: { keyHash, attemptCount: 1, windowStartedAt: now } });
      return;
    }
    if (current.attemptCount < 10) await tx.loginThrottle.update({ where: { keyHash }, data: { attemptCount: { increment: 1 } } });
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
    if (await accountIsLocked(email)) return NextResponse.json({ error: "RATE_LIMITED", message: "登录尝试过于频繁，请稍后再试" }, { status: 429 });
    const user = await prisma.user.findUnique({ where: { email } });
    const passwordMatches = user ? await bcrypt.compare(parsed.data.password, user.passwordHash) : false;
    if (!user || !passwordMatches) {
      await recordFailedAttempt(email);
      return NextResponse.json({ error: "INVALID_CREDENTIALS", message: "邮箱或密码错误" }, { status: 401 });
    }
    const session = await createSession(user.id);
    const response = NextResponse.json({ user: { id: user.id, email: user.email } });
    setSessionCookie(response, session.token, session.expiresAt);
    return response;
  } catch (error) {
    if (process.env.APP_MODE === "test") {
      const diagnostic = error instanceof Prisma.PrismaClientKnownRequestError ? `${error.code}: ${error.message}` : error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
      console.error("[auth-login-database-error]", diagnostic);
    }
    return NextResponse.json({ error: "DATABASE_ERROR", message: "登录服务暂不可用，请稍后重试" }, { status: 503 });
  }
}

import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { createSession, hashRateLimitKey, isSameOrigin, setSessionCookie } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { readBoundedJson, RequestJsonError } from "@/lib/request";
import { loginSchema } from "@/lib/validation";

export const runtime = "nodejs";

const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_RESERVATION_TTL_MS = 30_000;

type LoginAttemptReservation = {
  id: string;
  keyHash: string;
  windowStartedAt: Date;
  expiresAt: Date;
};

async function reserveLoginAttempt(email: string): Promise<LoginAttemptReservation | null> {
  const keyHash = hashRateLimitKey(email);
  const now = new Date();
  const windowStart = new Date(now.getTime() - 5 * 60 * 1000);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`test3:login:${keyHash}`}))::text AS locked`;
    const current = await tx.loginThrottle.findUnique({ where: { keyHash } });
    if (!current || current.windowStartedAt <= windowStart) {
      const throttle = await tx.loginThrottle.upsert({ where: { keyHash }, update: { attemptCount: 0, inFlightCount: 0, windowStartedAt: now }, create: { keyHash, attemptCount: 0, inFlightCount: 0, windowStartedAt: now } });
      await tx.loginThrottleReservation.updateMany({ where: { keyHash, releasedAt: null }, data: { releasedAt: now } });
      const reservation = await tx.loginThrottleReservation.create({ data: { keyHash, windowStartedAt: throttle.windowStartedAt, expiresAt: new Date(now.getTime() + LOGIN_RESERVATION_TTL_MS) } });
      await tx.loginThrottle.update({ where: { keyHash }, data: { inFlightCount: 1 } });
      return { id: reservation.id, keyHash, windowStartedAt: throttle.windowStartedAt, expiresAt: reservation.expiresAt };
    }
    await tx.loginThrottleReservation.updateMany({ where: { keyHash, releasedAt: null, expiresAt: { lte: now } }, data: { releasedAt: now } });
    const activeReservations = await tx.loginThrottleReservation.count({ where: { keyHash, releasedAt: null, expiresAt: { gt: now }, windowStartedAt: current.windowStartedAt } });
    if (current.attemptCount + activeReservations >= MAX_LOGIN_ATTEMPTS) {
      if (current.inFlightCount !== activeReservations) await tx.loginThrottle.update({ where: { keyHash }, data: { inFlightCount: activeReservations } });
      return null;
    }
    const reservation = await tx.loginThrottleReservation.create({ data: { keyHash, windowStartedAt: current.windowStartedAt, expiresAt: new Date(now.getTime() + LOGIN_RESERVATION_TTL_MS) } });
    await tx.loginThrottle.update({ where: { keyHash }, data: { inFlightCount: activeReservations + 1 } });
    return { id: reservation.id, keyHash, windowStartedAt: current.windowStartedAt, expiresAt: reservation.expiresAt };
  });
}

async function completeLoginAttempt(reservation: LoginAttemptReservation, failed: boolean) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`test3:login:${reservation.keyHash}`}))::text AS locked`;
    const owned = await tx.loginThrottleReservation.findUnique({ where: { id: reservation.id } });
    if (!owned || owned.releasedAt) return;
    await tx.loginThrottleReservation.update({ where: { id: owned.id }, data: { releasedAt: now } });
    const current = await tx.loginThrottle.findUnique({ where: { keyHash: reservation.keyHash } });
    if (!current || current.windowStartedAt.getTime() !== reservation.windowStartedAt.getTime() || owned.expiresAt <= now) return;
    await tx.loginThrottle.update({ where: { keyHash: reservation.keyHash }, data: { attemptCount: failed ? Math.min(current.attemptCount + 1, MAX_LOGIN_ATTEMPTS) : current.attemptCount, inFlightCount: Math.max(current.inFlightCount - 1, 0) } });
  });
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "CSRF_ORIGIN", message: "请求来源校验失败" }, { status: 403 });
  }
  let body: unknown;
  try { body = await readBoundedJson(request, 8 * 1024); }
  catch (error) { const code = error instanceof RequestJsonError ? error.code : "INVALID_JSON"; return NextResponse.json({ error: code, message: code === "REQUEST_TOO_LARGE" ? "登录请求不能超过 8 KiB" : "请求格式错误" }, { status: code === "REQUEST_TOO_LARGE" ? 413 : 400 }); }
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "VALIDATION_ERROR", message: "邮箱或密码格式错误" }, { status: 422 });
  }
  const email = parsed.data.email.toLowerCase();
  let reservation: LoginAttemptReservation | null = null;
  let completed = false;
  try {
    reservation = await reserveLoginAttempt(email);
    if (!reservation) return NextResponse.json({ error: "RATE_LIMITED", message: "登录尝试过于频繁，请稍后再试" }, { status: 429 });
    const user = await prisma.user.findUnique({ where: { email } });
    const passwordMatches = user ? await bcrypt.compare(parsed.data.password, user.passwordHash) : false;
    if (!user || !passwordMatches) {
      await completeLoginAttempt(reservation, true);
      completed = true;
      return NextResponse.json({ error: "INVALID_CREDENTIALS", message: "邮箱或密码错误" }, { status: 401 });
    }
    await completeLoginAttempt(reservation, false);
    completed = true;
    const session = await createSession(user.id);
    const response = NextResponse.json({ user: { id: user.id, email: user.email } });
    setSessionCookie(response, session.token, session.expiresAt);
    return response;
  } catch (error) {
    if (reservation && !completed) {
      try { await completeLoginAttempt(reservation, false); } catch { /* preserve the generic login error */ }
    }
    if (process.env.APP_MODE === "test") {
      const diagnostic = error instanceof Prisma.PrismaClientKnownRequestError ? `${error.code}: ${error.message}` : error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
      console.error("[auth-login-database-error]", diagnostic);
    }
    return NextResponse.json({ error: "DATABASE_ERROR", message: "登录服务暂不可用，请稍后重试" }, { status: 503 });
  }
}

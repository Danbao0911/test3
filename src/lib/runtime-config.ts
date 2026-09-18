import { createHash } from "node:crypto";

export type RuntimeMode = "demo" | "production" | "test";

const rawMode = process.env.APP_MODE ?? "production";
if (rawMode !== "demo" && rawMode !== "production" && rawMode !== "test") {
  throw new Error("APP_MODE 必须是 demo、production 或 test");
}

export const RUNTIME_MODE = rawMode as RuntimeMode;

export function currentRuntimeMode(): RuntimeMode {
  const mode = process.env.APP_MODE ?? "production";
  if (mode !== "demo" && mode !== "production" && mode !== "test") throw new Error("APP_MODE 必须是 demo、production 或 test");
  return mode;
}
function trustedOrigin() {
  const rawOrigin = process.env.APP_ORIGIN;
  if (!rawOrigin) throw new Error("必须设置服务端可信 APP_ORIGIN");
  try {
    const origin = new URL(rawOrigin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || (origin.pathname !== "/" && origin.pathname !== "")) throw new Error("invalid origin");
    return origin.origin;
  } catch {
    throw new Error("APP_ORIGIN 必须是包含协议、主机和端口的可信源地址");
  }
}

function databaseName() {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("必须设置 DATABASE_URL");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("DATABASE_URL 格式无效");
  }
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!name) throw new Error("DATABASE_URL 必须包含数据库名称");
  return { url, name };
}

export function assertRuntimeConfiguration() {
  trustedOrigin();
  const databaseTarget = databaseName();
  const mode = currentRuntimeMode();
  if (mode === "demo" && !/(^|[_-])demo([_-]|$)/i.test(databaseTarget.name)) throw new Error("演示模式只能连接名称含 demo 标记的独立数据库");
  if (mode === "test") {
    const testUrl = process.env.TEST_DATABASE_URL;
    if (!testUrl || testUrl !== process.env.DATABASE_URL || !/(^|[_-])(test|ci|e2e)([_-]|$)/i.test(databaseTarget.name)) throw new Error("测试模式必须使用与 TEST_DATABASE_URL 完全一致且带 test/ci/e2e 标记的独立数据库");
  }
  if (mode === "production" && /(^|[_-])(demo|test|ci|e2e)([_-]|$)/i.test(databaseTarget.name)) throw new Error("生产模式拒绝连接演示或测试数据库");
  return { databaseTarget, trustedOrigin: trustedOrigin() };
}

export function getTrustedOrigin() { return trustedOrigin(); }

export function isSyntheticMode() {
  const mode = currentRuntimeMode();
  return mode === "demo" || mode === "test";
}

export function sourceTypeAllowed(type: "DEMO" | "AUTHORIZED_MANUAL") {
  return isSyntheticMode() ? type === "DEMO" : type === "AUTHORIZED_MANUAL";
}

export function hashRateLimitKey(value: string) {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

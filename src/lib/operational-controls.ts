import { createHash } from "node:crypto";

/**
 * T10's platform transport is intentionally a closed circuit.  These values
 * are local safety controls, not claims about any vendor quota.
 */
export const PLATFORM_OPERATIONAL_CONTROL = {
  externalRequestsEnabled: false,
  maxRequests: 0,
  automaticRetries: 0,
} as const;

export const T10_ALERT_POLICY = {
  ciFailure: "required",
  migrationFailure: "required",
  maintenanceIncomplete: "required",
  productionChannel: "not_deployed",
} as const;

const PLATFORM_CREDENTIAL_KEYS = [
  "YOUTUBE_API_KEY",
  "YOUTUBE_ACCESS_TOKEN",
  "X_API_KEY",
  "X_API_SECRET",
  "X_ACCESS_TOKEN",
  "X_ACCESS_TOKEN_SECRET",
  "XIAOHONGSHU_APP_ID",
  "XIAOHONGSHU_APP_SECRET",
  "XIAOHONGSHU_ACCESS_TOKEN",
  "DOUYIN_APP_ID",
  "DOUYIN_APP_SECRET",
  "DOUYIN_ACCESS_TOKEN",
] as const;

type Environment = Record<string, string | undefined>;

export type OperationalPreflight = {
  status: "ready" | "blocked";
  runtimeMode: string;
  database: { host: string | null; name: string | null };
  platform: typeof PLATFORM_OPERATIONAL_CONTROL;
  alerts: typeof T10_ALERT_POLICY;
  platformCredentialCount: number;
  issues: string[];
};

function databaseTarget(raw: string | undefined) {
  if (!raw) return { host: null, name: null };
  try {
    const url = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.username === "" || url.password === "") return { host: null, name: null };
    const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
    return { host: url.hostname, name: name || null };
  } catch {
    return { host: null, name: null };
  }
}

function hasIsolatedTestDatabase(env: Environment, database: { host: string | null; name: string | null }) {
  return env.APP_MODE === "test" && env.TEST_DATABASE_MODE === "isolated" &&
    Boolean(env.TEST_DATABASE_URL) && env.TEST_DATABASE_URL === env.DATABASE_URL &&
    Boolean(env.TEST_RUN_ID) && database.host === "127.0.0.1" &&
    Boolean(database.name && /^test3_(?:ci|e2e|test)_[a-z0-9-]+$/i.test(database.name) && database.name.endsWith(`_${env.TEST_RUN_ID}`));
}

export function collectOperationalPreflight(env: Environment = process.env): OperationalPreflight {
  const database = databaseTarget(env.DATABASE_URL);
  const configuredCredentials = PLATFORM_CREDENTIAL_KEYS.filter((key) => Boolean(env[key])).length;
  const issues: string[] = [];
  if (env.APP_MODE !== "test" && env.APP_MODE !== "demo" && env.APP_MODE !== "production") issues.push("APP_MODE_INVALID");
  if (!database.host || !database.name) issues.push("DATABASE_TARGET_INVALID");
  if (env.APP_MODE === "test" && !hasIsolatedTestDatabase(env, database)) issues.push("TEST_DATABASE_NOT_ISOLATED");
  if (configuredCredentials > 0) issues.push("PLATFORM_CREDENTIALS_MUST_REMAIN_UNCONFIGURED");
  return {
    status: issues.length ? "blocked" : "ready",
    runtimeMode: env.APP_MODE ?? "unset",
    database,
    platform: PLATFORM_OPERATIONAL_CONTROL,
    alerts: T10_ALERT_POLICY,
    platformCredentialCount: configuredCredentials,
    issues,
  };
}

export function assertT10IsolatedEnvironment(env: Environment = process.env) {
  const preflight = collectOperationalPreflight(env);
  if (preflight.status !== "ready" || env.APP_MODE !== "test" || !hasIsolatedTestDatabase(env, preflight.database)) {
    throw new Error(`T10 只允许使用受保护的隔离测试库：${preflight.issues.join(",") || "运行模式不是 test"}`);
  }
  if (preflight.platformCredentialCount > 0) throw new Error("T10 演练拒绝已配置的平台凭据");
  return preflight;
}

export function stableOperationalRunId(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}


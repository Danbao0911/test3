import { isIP } from "node:net";
import type { Platform } from "../generated/prisma/client";
import { isSyntheticMode } from "./runtime-config";

export class UrlValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "UrlValidationError";
  }
}

const platformHosts: Record<Platform, string[]> = {
  XIAOHONGSHU: ["xiaohongshu.com", "www.xiaohongshu.com"],
  YOUTUBE: ["youtube.com", "www.youtube.com"],
  X: ["x.com", "www.x.com", "twitter.com", "www.twitter.com"],
  DOUYIN: ["douyin.com", "www.douyin.com"],
};

const canonicalHosts: Record<Platform, string> = {
  XIAOHONGSHU: "xiaohongshu.com",
  YOUTUBE: "youtube.com",
  X: "x.com",
  DOUYIN: "douyin.com",
};

const trackingParams = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "fbclid",
  "gclid",
  "si",
]);

function isAllowedHost(hostname: string, allowedHosts: string[]) {
  return allowedHosts.includes(hostname);
}

function rejectUnsafeUrl(url: URL) {
  if (url.protocol !== "https:") throw new UrlValidationError("URL_SCHEME", "只接受 HTTPS 链接");
  if (url.username || url.password) throw new UrlValidationError("URL_CREDENTIALS", "链接不能包含用户名或密码");
  const hostForIpCheck = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostForIpCheck) || url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
    throw new UrlValidationError("URL_PRIVATE_HOST", "链接不能指向本机或 IP 地址");
  }
  if (url.port && url.port !== "443") throw new UrlValidationError("URL_PORT", "链接端口不符合要求");
}

function cleanUrl(url: URL) {
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (trackingParams.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) {
      url.searchParams.delete(key);
    }
  }
  url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
  return url.toString();
}

function isAccountPath(platform: Platform, pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  if (platform === "XIAOHONGSHU") return segments.length === 3 && segments[0] === "user" && segments[1] === "profile" && Boolean(segments[2]);
  if (platform === "YOUTUBE") {
    return (segments.length === 2 && ["channel", "c", "user"].includes(segments[0]) && Boolean(segments[1])) || (segments.length === 1 && /^@[^/]+$/.test(segments[0] ?? ""));
  }
  if (platform === "X") {
    const reserved = new Set(["search", "explore", "home", "i", "settings", "notifications", "messages"]);
    return segments.length === 1 && /^[A-Za-z0-9_]{1,15}$/.test(segments[0] ?? "") && !reserved.has((segments[0] ?? "").toLowerCase());
  }
  return segments.length === 2 && segments[0] === "user" && Boolean(segments[1]);
}

export function normalizeProfileUrl(platform: Platform, rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new UrlValidationError("URL_FORMAT", "主页链接格式无效");
  }
  rejectUnsafeUrl(url);
  const hostname = url.hostname.toLowerCase();
  const isDemoUrl = isSyntheticMode() && hostname === "example.com" && url.pathname.startsWith("/demo/");
  if (isSyntheticMode() && !isDemoUrl) throw new UrlValidationError("SYNTHETIC_ONLY", "演示/测试模式只接受 example.com/demo/ 下的虚构主页");
  if (!isDemoUrl && !isAllowedHost(hostname, platformHosts[platform])) {
    throw new UrlValidationError("URL_DOMAIN", "链接不是该平台允许的主页域名");
  }
  if (!isDemoUrl && !isAccountPath(platform, url.pathname)) {
    throw new UrlValidationError("URL_NOT_PROFILE", "链接必须是账号主页，不能是帖子、视频或搜索页");
  }
  url.hostname = isDemoUrl ? hostname : canonicalHosts[platform];
  return cleanUrl(url);
}

export function normalizeSourceUrl(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new UrlValidationError("SOURCE_URL_FORMAT", "来源链接格式无效");
  }
  rejectUnsafeUrl(url);
  url.hostname = url.hostname.toLowerCase();
  if (isSyntheticMode() && !["example.com", "example.net", "example.org"].includes(url.hostname)) throw new UrlValidationError("SYNTHETIC_ONLY", "演示/测试证据来源只接受 example.com/net/org");
  return cleanUrl(url);
}

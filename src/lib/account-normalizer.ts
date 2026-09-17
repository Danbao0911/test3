import { isIP } from "node:net";
import type { Platform } from "../generated/prisma/client";

export class UrlValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "UrlValidationError";
  }
}

const platformHosts: Record<Platform, string[]> = {
  XIAOHONGSHU: ["xiaohongshu.com"],
  YOUTUBE: ["youtube.com", "youtu.be"],
  X: ["x.com", "twitter.com"],
  DOUYIN: ["douyin.com"],
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
  return allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

function rejectUnsafeUrl(url: URL) {
  if (url.protocol !== "https:") throw new UrlValidationError("URL_SCHEME", "只接受 HTTPS 链接");
  if (url.username || url.password) throw new UrlValidationError("URL_CREDENTIALS", "链接不能包含用户名或密码");
  if (isIP(url.hostname) || url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
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
  const path = pathname.toLowerCase();
  if (platform === "XIAOHONGSHU") return /^\/user\/profile\/[^/]+/.test(path);
  if (platform === "YOUTUBE") {
    return (/^\/(channel|c|user)\/[^/]+/.test(path) || /^\/@[^/]+/.test(path)) && !/(watch|shorts|playlist|results|live)/.test(path);
  }
  if (platform === "X") return /^\/[a-z0-9_]{1,15}\/?$/i.test(path) && !/^(\/search|\/explore|\/home|\/i)(\/|$)/.test(path);
  return /^\/user\/[^/]+/.test(path) && !/^\/(video|search|discover)(\/|$)/.test(path);
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
  const isDemoUrl = process.env.APP_MODE === "demo" && hostname === "example.com" && url.pathname.startsWith("/demo/");
  if (!isDemoUrl && !isAllowedHost(hostname, platformHosts[platform])) {
    throw new UrlValidationError("URL_DOMAIN", "链接不是该平台允许的主页域名");
  }
  if (!isDemoUrl && !isAccountPath(platform, url.pathname)) {
    throw new UrlValidationError("URL_NOT_PROFILE", "链接必须是账号主页，不能是帖子、视频或搜索页");
  }
  url.hostname = hostname;
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
  return cleanUrl(url);
}

import { describe, expect, it, beforeEach } from "vitest";
import { normalizeProfileUrl, normalizeSourceUrl } from "../../src/lib/account-normalizer";

describe("normalizeProfileUrl", () => {
  beforeEach(() => { process.env.APP_MODE = "demo"; });

  it("accepts an isolated demo profile and removes tracking parameters", () => {
    expect(normalizeProfileUrl("YOUTUBE", "https://example.com/demo/YouTube/001?utm_source=test#bio"))
      .toBe("https://example.com/demo/YouTube/001");
  });

  it("rejects non-HTTPS and non-profile URLs", () => {
    expect(() => normalizeProfileUrl("YOUTUBE", "http://example.com/demo/youtube/001")).toThrow("只接受 HTTPS");
    expect(() => normalizeProfileUrl("X", "https://x.com/search?q=wealth")).toThrow("账号主页");
  });

  it("does not request remote URLs", () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => { called = true; throw new Error("network should not be used"); }) as typeof fetch;
    normalizeProfileUrl("DOUYIN", "https://example.com/demo/douyin/001");
    globalThis.fetch = originalFetch;
    expect(called).toBe(false);
  });
});

describe("normalizeSourceUrl", () => {
  it("rejects local and credential-bearing URLs", () => {
    expect(() => normalizeSourceUrl("https://localhost/source")).toThrow("本机");
    expect(() => normalizeSourceUrl("https://user:pass@example.com/source")).toThrow("用户名或密码");
  });
});

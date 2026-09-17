import { describe, expect, it, vi } from "vitest";
import { extractContacts, isSyntheticContact, type ContactKind, type TextContext } from "../../src/lib/contact-extractor";
import { contactUsable, extractionAllowed } from "../../src/lib/contact-policy";
import { canMaintain, canManageSources } from "../../src/lib/permissions";

const positives: Array<[string, ContactKind, string]> = [
  ["商务邮箱：business@example.com", "EMAIL", "business@example.com"],
  ["合作邮箱: Team@EXAMPLE.COM", "EMAIL", "Team@example.com"],
  ["business email: sales@example.org", "EMAIL", "sales@example.org"],
  ["Business inquiries: hello+team@example.net", "EMAIL", "hello+team@example.net"],
  ["本公司业务邮箱：team@example.com", "EMAIL", "team@example.com"],
  ["partnership email: partner@example.com", "EMAIL", "partner@example.com"],
  ["商务邮箱：friend@example.com", "EMAIL", "friend@example.com"],
  ["商务邮箱：invalid@example.com", "EMAIL", "invalid@example.com"],
  ["商务微信：demo_team", "WECHAT", "demo_team"],
  ["合作微信: demo_Abc123", "WECHAT", "demo_Abc123"],
  ["business wechat: demo_team-1", "WECHAT", "demo_team-1"],
  ["官方商务微信：demo_studio", "WECHAT", "demo_studio"],
  ["企业电话：+1 202 555 0100", "PHONE", "+12025550100"],
  ["公司电话: +1 (202) 555-0199", "PHONE", "+12025550199"],
  ["公司总机：+1 202 555 0111", "PHONE", "+12025550111"],
  ["business phone: +12025550123", "PHONE", "+12025550123"],
  ["官网联系页：https://example.com/contact", "CONTACT_URL", "https://example.com/contact"],
  ["商务联系页：https://example.org/contact", "CONTACT_URL", "https://example.org/contact"],
  ["contact page: https://example.net/contact", "CONTACT_URL", "https://example.net/contact"],
  ["商务预约：https://example.com/book", "BOOKING_URL", "https://example.com/book"],
  ["咨询预约：https://example.org/appointment", "BOOKING_URL", "https://example.org/appointment"],
  ["预约链接：https://example.com/schedule", "BOOKING_URL", "https://example.com/schedule"],
  ["booking link: https://example.net/book", "BOOKING_URL", "https://example.net/book"],
  ["appointment link: https://example.com/meet", "BOOKING_URL", "https://example.com/meet"],
];

const negatives = [
  "", "提供财富规划服务，暂无联系信息", "business@example.com", "邮箱：business@example.com",
  "私人邮箱：private@example.com", "朋友的商务邮箱：friend@example.com", "第三方商务邮箱：third@example.com",
  "评论 商务邮箱：comment@example.com", "广告 商务邮箱：ads@example.com", "推荐商务邮箱：other@example.com",
  "商务邮箱：invalid", "商务邮箱：a@@example.com", "商务邮箱：a@example", "商务邮箱：a b@example.com",
  "商务邮箱：a@example.com b@example.com", "商务邮箱：a@example.com（已失效）", "商务邮箱：不要联系@example.com",
  "商务微信：abc", "微信：demo_team", "商务微信：12345678", "商务微信：demo_invalid_identifier_too_long",
  "企业电话：123", "电话：+12025550100", "企业电话：12345678901", "企业电话：+1234567890123456", "企业电话：+12025550100x123",
  "官网联系页：http://example.com/contact", "官网联系页：https://localhost/contact", "官网联系页：https://[::1]/contact",
  "官网联系页：https://127.0.0.1/contact", "官网联系页：https://user:pass@example.com/contact", "官网联系页：javascript:alert(1)",
  "商务邮箱：<script>alert(1)</script>", "请猜测公司邮箱", "谢绝联系；暂无联系信息", "商务邮箱：team@example.com（示例格式）",
  "第三方资料\n商务邮箱：third@example.com", "以下为评论内容\n商务邮箱：comment@example.com",
];

describe("T04 deterministic contact extraction (synthetic fixtures only)", () => {
  it.each(positives)("recognizes %s", (text, type, normalizedValue) => {
    const result = extractContacts(text, "ACCOUNT_PROFILE");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type, normalizedValue, excerpt: text });
    expect(isSyntheticContact(type, normalizedValue)).toBe(true);
  });
  it.each(negatives)("does not guess from %s", text => expect(extractContacts(text, "ACCOUNT_PROFILE")).toEqual([]));
  it.each<TextContext>(["COMMENT", "ADVERTISEMENT", "THIRD_PARTY"])("never attributes %s to subject", context => {
    expect(extractContacts("商务邮箱：team@example.com", context)).toEqual([]);
  });
  it("deduplicates exact contacts but preserves email/WeChat case-sensitive identifiers", () => {
    expect(extractContacts("商务邮箱：A@example.com\n商务邮箱：A@EXAMPLE.COM\n商务邮箱：a@example.com", "ACCOUNT_PROFILE")).toHaveLength(2);
  });
  it("keeps field-specific snippets and never fetches URLs", () => {
    const network = vi.spyOn(globalThis, "fetch");
    try {
      const result = extractContacts("机构介绍\n商务邮箱：a@example.com\n商务微信：demo_team\n无关资料", "ACCOUNT_PROFILE");
      expect(result).toHaveLength(2);
      expect(result[0].excerpt).not.toContain("demo_team");
      expect(result[1].excerpt).not.toContain("a@example.com");
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it("rejects real-looking values from synthetic acceptance", () => {
    expect(isSyntheticContact("EMAIL", "person@not-example.invalid")).toBe(false);
    expect(isSyntheticContact("WECHAT", "realperson")).toBe(false);
    expect(isSyntheticContact("PHONE", "+8613000000000")).toBe(false);
    expect(isSyntheticContact("CONTACT_URL", "https://example.com.invalid/contact")).toBe(false);
  });
});

const source = { status: "APPROVED", allowExtract: true, allowEvidenceText: true, permissionNote: "Synthetic permission", expiresAt: null, policyVersion: 3 };
describe("contact capability and role boundaries", () => {
  it.each([
    { status: "DRAFT" }, { status: "REVOKED" }, { allowExtract: false }, { allowEvidenceText: false },
    { permissionNote: " " }, { expiresAt: new Date(0) },
  ])("blocks extraction under restricted policy %j", patch => expect(extractionAllowed({ ...source, ...patch })).toBe(false));
  it("approved contact becomes unusable after expiry, policy changes or invalidation", () => {
    const contact = { status: "APPROVED", ownershipConfirmed: true, businessConfirmed: true, reviewedAt: new Date(), expiresAt: new Date(Date.now() + 60000), evidence: { policyVersion: 3, source } };
    expect(contactUsable(contact)).toBe(true);
    expect(contactUsable({ ...contact, expiresAt: new Date(0) })).toBe(false);
    expect(contactUsable({ ...contact, status: "INVALID" })).toBe(false);
    expect(contactUsable({ ...contact, ownershipConfirmed: false })).toBe(false);
    expect(contactUsable({ ...contact, evidence: { ...contact.evidence, policyVersion: 2 } })).toBe(false);
  });
  it("only administrators manage sources; reviewers maintain; viewers cannot write", () => {
    expect(canManageSources("ADMIN")).toBe(true);
    expect(canManageSources("REVIEWER")).toBe(false);
    expect(canManageSources("VIEWER")).toBe(false);
    expect(canMaintain("REVIEWER")).toBe(true);
    expect(canMaintain("VIEWER")).toBe(false);
  });
});

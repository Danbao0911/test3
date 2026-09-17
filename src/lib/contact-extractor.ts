import { z } from "zod";
import { normalizeSourceUrl } from "./account-normalizer";

export type ContactKind = "EMAIL" | "WECHAT" | "PHONE" | "CONTACT_URL" | "BOOKING_URL";
export type TextContext = "ACCOUNT_PROFILE" | "COMMENT" | "ADVERTISEMENT" | "THIRD_PARTY";
export type Candidate = { type: ContactKind; rawValue: string; normalizedValue: string; excerpt: string; locator: string };

const labels: Array<[ContactKind, RegExp]> = [
  ["EMAIL", /^(?:本公司|本账号|官方)?\s*(?:商务邮箱|合作邮箱|业务邮箱|business email|business inquiries|partnership email)\s*[:：]\s*(.+)$/i],
  ["WECHAT", /^(?:本公司|本账号|官方)?\s*(?:商务微信|合作微信|business wechat)\s*[:：]\s*(.+)$/i],
  ["PHONE", /^(?:本公司|本账号|官方)?\s*(?:企业电话|公司电话|公司总机|business phone|company phone)\s*[:：]\s*(.+)$/i],
  ["CONTACT_URL", /^(?:官网联系页|商务联系页|contact page|business contact page)\s*[:：]\s*(.+)$/i],
  ["BOOKING_URL", /^(?:商务预约|咨询预约|预约链接|booking link|appointment link)\s*[:：]\s*(.+)$/i],
];
const unsafeContext = /第三[人方]|评论|广告|朋友|推荐|私人|个人邮箱|勿联系|不要联系|不再联系|谢绝|拒绝联系|已失效|已停用|已过期|示例格式|例如|comment|advertisement|third.party|friend|personal|do not contact|expired|invalid|example format|e\.g\./i;

function normalize(type: ContactKind, raw: string): string | null {
  if (type === "EMAIL") {
    if (raw.length > 254 || !z.email().safeParse(raw).success) return null;
    // Preserve potentially case-sensitive local parts; only fold the domain.
    const at = raw.lastIndexOf("@");
    return raw.slice(0, at) + "@" + raw.slice(at + 1).toLowerCase();
  }
  if (type === "WECHAT") return /^[a-zA-Z][a-zA-Z0-9_-]{5,19}$/.test(raw) ? raw : null;
  if (type === "PHONE") {
    if (!/^[+\d() -]+$/.test(raw)) return null;
    const value = raw.replace(/[() -]/g, "");
    return /^(?:\+[1-9]\d{6,14}|0\d{9,11})$/.test(value) ? value : null;
  }
  try { return normalizeSourceUrl(raw); } catch { return null; }
}

export function isSyntheticContact(type: ContactKind, value: string) {
  if (type === "EMAIL") return /@example\.(com|net|org)$/i.test(value);
  if (type === "WECHAT") return /^demo_[a-z0-9_-]+$/i.test(value);
  if (type === "PHONE") return /^\+120255501\d{2}$/.test(value);
  try { return ["example.com", "example.net", "example.org"].includes(new URL(value).hostname); } catch { return false; }
}

/** Conservative labelled-field grammar. It deliberately does not infer ownership. */
export function extractContacts(text: string, context: TextContext): Candidate[] {
  if (context !== "ACCOUNT_PROFILE") return [];
  const segments = text.split(/\r?\n|[；;]/);
  // Context markers outside a labelled value taint the supplied block. Words in a
  // syntactically valid address (friend@..., invalid@...) are not context labels.
  if (segments.some(segment => !labels.some(([, pattern]) => pattern.test(segment.trim())) && unsafeContext.test(segment))) return [];
  const found = new Map<string, Candidate>();
  let offset = 0;
  for (const segment of segments) {
    const line = segment.trim();
    if (line.length <= 300 && !unsafeContext.test(line.split(/[:：]/, 1)[0])) {
      for (const [type, pattern] of labels) {
        const match = line.match(pattern);
        if (!match) continue;
        const rawValue = match[1].trim().replace(/[。，]$/, "");
        const normalizedValue = normalize(type, rawValue);
        if (normalizedValue) {
          const key = `${type}:${normalizedValue}`;
          if (!found.has(key)) found.set(key, { type, rawValue, normalizedValue, excerpt: line, locator: `字符附近 ${offset + 1}` });
        }
      }
    }
    offset += segment.length + 1;
  }
  return [...found.values()];
}

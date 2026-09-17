import { z } from "zod";
import { normalizeContactTargetUrl } from "./account-normalizer";

export type ContactKind = "EMAIL" | "WECHAT" | "PHONE" | "CONTACT_URL" | "BOOKING_URL";
export type TextContext = "ACCOUNT_PROFILE" | "COMMENT" | "ADVERTISEMENT" | "THIRD_PARTY";
export type Candidate = { type: ContactKind; rawValue: string; normalizedValue: string; excerpt: string; locator: string };

type Field = { type: ContactKind; value: string; line: string };
const labels: Array<[ContactKind, RegExp]> = [
  ["EMAIL", /^(?:本公司|本账号|官方)?\s*(?:商务邮箱|合作邮箱|业务邮箱|business email|business inquiries|partnership email)\s*[:：]\s*(.*)$/i],
  ["WECHAT", /^(?:本公司|本账号|官方)?\s*(?:商务微信|合作微信|business wechat)\s*[:：]\s*(.*)$/i],
  ["PHONE", /^(?:本公司|本账号|官方)?\s*(?:企业电话|公司电话|公司总机|business phone|company phone)\s*[:：]\s*(.*)$/i],
  ["CONTACT_URL", /^(?:官网联系页|商务联系页|contact page|business contact page)\s*[:：]\s*(.*)$/i],
  ["BOOKING_URL", /^(?:商务预约|咨询预约|预约链接|booking link|appointment link)\s*[:：]\s*(.*)$/i],
];

// These are context markers, not address fragments. In particular, do not reject
// valid values such as friend@example.com or invalid@example.com.
const contextMarker = /第三[人方]|评论|广告|归属不明|主体不明|非本账号|私人联系方式|勿联系|不要联系|不再联系|谢绝联系|拒绝联系|已失效|已停用|已过期|示例格式|不可用|do\s+not\s+contact|no\s+contact|third[-\s.]?party|comment|advertisement|unverified|expired|outdated|example\s+format|e\.g\./i;
const urlToken = /https?:\/\/[^\s（）]+/gi;
const emailToken = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi;

function hasOuterContext(text: string) {
  return contextMarker.test(text.replace(urlToken, " ").replace(emailToken, " "));
}

function fieldFromLine(line: string): Field | null {
  for (const [type, pattern] of labels) {
    const match = line.match(pattern);
    if (match) return { type, value: match[1].trim(), line };
  }
  return null;
}

function normalize(type: ContactKind, raw: string): string | null {
  if (type === "EMAIL") {
    const value = raw.replace(/[。，]$/, "").trim();
    if (value.length > 254 || !z.email().safeParse(value).success) return null;
    const at = value.lastIndexOf("@");
    return value.slice(0, at) + "@" + value.slice(at + 1).toLowerCase();
  }
  if (type === "WECHAT") return /^[a-zA-Z][a-zA-Z0-9_-]{5,19}$/.test(raw) ? raw : null;
  if (type === "PHONE") {
    if (!/^[+\d() -]+$/.test(raw)) return null;
    const value = raw.replace(/[() -]/g, "");
    return /^(?:\+[1-9]\d{6,14}|0\d{9,11})$/.test(value) ? value : null;
  }
  try { return normalizeContactTargetUrl(raw); } catch { return null; }
}

export function isSyntheticContact(type: ContactKind, value: string) {
  if (type === "EMAIL") return /@example\.(com|net|org)$/i.test(value);
  if (type === "WECHAT") return /^demo_[a-z0-9_-]+$/i.test(value);
  if (type === "PHONE") return /^\+120255501\d{2}$/.test(value);
  try { return ["example.com", "example.net", "example.org"].includes(new URL(value).hostname); } catch { return false; }
}

/** Parse one labelled field per line after checking outer context. A semicolon is
 * URL data, never a record delimiter. Unsupported multi-field lines fail closed. */
export function extractContacts(text: string, context: TextContext): Candidate[] {
  if (context !== "ACCOUNT_PROFILE" || hasOuterContext(text)) return [];
  const found = new Map<string, Candidate>();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.length > 300) continue;
    const field = fieldFromLine(line.trim());
    if (!field || hasOuterContext(field.line)) continue;
    const normalizedValue = normalize(field.type, field.value);
    if (!normalizedValue) continue;
    const key = `${field.type}:${normalizedValue}`;
    if (!found.has(key)) found.set(key, { type: field.type, rawValue: field.value, normalizedValue, excerpt: field.line.trim(), locator: `第 ${index + 1} 行` });
  }
  return [...found.values()];
}

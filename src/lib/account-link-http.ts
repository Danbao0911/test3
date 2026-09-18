import { NextResponse } from "next/server";
import { AccountLinkError } from "./account-link-service";

export const MAX_ACCOUNT_LINK_JSON_BYTES = 16 * 1024;

export function accountLinkErrorResponse(error: unknown) {
  if (error instanceof AccountLinkError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
  }
  return NextResponse.json({ error: "DATABASE_ERROR", message: "账号关联操作失败；未提交的事务已回滚" }, { status: 500 });
}

export async function readAccountLinkJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    throw new AccountLinkError("INVALID_JSON", "需要 JSON 请求", 400);
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (!Number.isFinite(length) || length < 0) throw new AccountLinkError("INVALID_JSON", "请求长度无效", 400);
    if (length > MAX_ACCOUNT_LINK_JSON_BYTES) throw new AccountLinkError("REQUEST_TOO_LARGE", "账号关联请求体不能超过 16 KiB", 413);
  }
  if (!request.body) throw new AccountLinkError("INVALID_JSON", "请求体为空", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_ACCOUNT_LINK_JSON_BYTES) {
        await reader.cancel();
        throw new AccountLinkError("REQUEST_TOO_LARGE", "账号关联请求体不能超过 16 KiB", 413);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new AccountLinkError("INVALID_JSON", "JSON 格式无效", 400);
  }
}

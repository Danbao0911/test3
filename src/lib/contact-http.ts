import { NextResponse } from "next/server";
import { ContactError } from "./contact-service";

export async function readContactJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new ContactError("INVALID_JSON", "需要 JSON 请求", 400);
  if (!request.body) throw new ContactError("INVALID_JSON", "请求体不能为空", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32 * 1024) { await reader.cancel(); throw new ContactError("REQUEST_TOO_LARGE", "联系请求最大 32 KiB", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ContactError("INVALID_JSON", "JSON 格式无效", 400); }
}

export function contactErrorResponse(error: unknown) {
  if (error instanceof ContactError) return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
  return NextResponse.json({ error: "DATABASE_ERROR", message: "联系操作失败，请稍后重试；未提交的事务已回滚" }, { status: 500 });
}

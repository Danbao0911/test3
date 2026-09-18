import { NextResponse } from "next/server";
import { AccountLinkError } from "./account-link-service";

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
  try {
    return await request.json();
  } catch {
    throw new AccountLinkError("INVALID_JSON", "JSON 格式无效", 400);
  }
}

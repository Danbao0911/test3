import { NextResponse } from "next/server";
import type { Prisma, ContactStatus } from "@/generated/prisma/client";
import { getCurrentUser, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { contactDto, contactInclude } from "@/lib/contact-service";
import { contactErrorResponse } from "@/lib/contact-http";
import { parsePositiveInt, uuidSchema } from "@/lib/validation";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const url = new URL(request.url);
  const accountId = url.searchParams.get("accountId");
  const status = url.searchParams.get("status");
  if ((accountId && !uuidSchema.safeParse(accountId).success) || (status && !["PENDING", "APPROVED", "REJECTED", "INVALID"].includes(status))) return NextResponse.json({ error: "VALIDATION_ERROR", message: "筛选条件无效" }, { status: 422 });
  const page = parsePositiveInt(url.searchParams.get("page"), 1, 100000);
  const pageSize = 20;
  const where: Prisma.ContactPointWhereInput = { ...(accountId ? { evidence: { accountId } } : {}), ...(status ? { status: status as ContactStatus } : {}) };
  try {
    const [items, total] = await prisma.$transaction([
      prisma.contactPoint.findMany({ where, include: contactInclude, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
      prisma.contactPoint.count({ where }),
    ]);
    return NextResponse.json({ items: items.map(item => contactDto(item, user.role)), total, page, pageSize }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return contactErrorResponse(error); }
}

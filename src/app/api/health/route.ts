import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", database: "up", timestamp: new Date().toISOString() });
  } catch {
    return NextResponse.json({ status: "error", database: "down" }, { status: 503 });
  }
}

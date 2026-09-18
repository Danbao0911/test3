import { NextResponse } from "next/server";
import { getCurrentUser, unauthorized } from "@/lib/auth";
import { platformCapabilityList } from "@/connectors/registry";

export async function GET() {
  if (!await getCurrentUser()) return unauthorized();
  return NextResponse.json({ items: platformCapabilityList() }, { headers: { "Cache-Control": "private, no-store" } });
}

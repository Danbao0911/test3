import { NextResponse } from "next/server";
import { getCurrentUser, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { uuidSchema } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: "NOT_FOUND", message: "来源不存在" }, { status: 404 });
  const source = await prisma.source.findUnique({ where: { id }, select: { id: true } });
  if (!source) return NextResponse.json({ error: "NOT_FOUND", message: "来源不存在" }, { status: 404 });
  const snapshots = await prisma.sourcePolicySnapshot.findMany({
    where: { sourceId: id }, orderBy: { version: "desc" },
    include: { changedBy: { select: { id: true, email: true } } },
  });
  const items = snapshots.map(snapshot => user.role === "VIEWER" ? {
    version: snapshot.version, status: snapshot.status, recordedAt: snapshot.recordedAt,
    changeType: snapshot.changeType, isLegacy: snapshot.isLegacy,
  } : {
    version: snapshot.version, status: snapshot.status, allowImport: snapshot.allowImport,
    allowExtract: snapshot.allowExtract, allowEvidenceText: snapshot.allowEvidenceText,
    allowRelate: snapshot.allowRelate,
    allowExport: snapshot.allowExport,
    allowedExportFields: snapshot.allowedExportFields ? JSON.parse(snapshot.allowedExportFields) : null,
    retentionDays: snapshot.retentionDays, expiresAt: snapshot.expiresAt,
    permissionNote: snapshot.permissionNote, authorizationBasis: snapshot.authorizationBasis,
    changedBy: snapshot.changedBy, recordedAt: snapshot.recordedAt,
    changeType: snapshot.changeType, isLegacy: snapshot.isLegacy,
  });
  return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
}

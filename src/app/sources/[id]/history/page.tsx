import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { uuidSchema } from "@/lib/validation";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const source = await prisma.source.findUnique({ where: { id }, select: { id: true, name: true, policyVersion: true } });
  if (!source) notFound();
  const snapshots = await prisma.sourcePolicySnapshot.findMany({ where: { sourceId: id }, orderBy: { version: "desc" }, include: { changedBy: { select: { email: true } } } });
    return <main className="page"><div className="page-header"><div><h1 className="page-title">{source.name} · 策略历史</h1><p className="page-subtitle">当前策略 v{source.policyVersion}；legacy/unknown 仅表示迁移前无法还原授权，不能作为新授权依据。</p></div><Link className="button secondary" href="/sources">返回数据来源</Link></div><section className="card"><div className="table-wrap"><table><thead><tr><th>版本 / 类型</th><th>记录时间 / 操作人</th><th>状态</th>{user.role !== "VIEWER" && <><th>允许能力</th><th>授权依据</th></>}</tr></thead><tbody>{snapshots.map(snapshot => user.role === "VIEWER" ? <tr key={snapshot.id}><td>v{snapshot.version} · {snapshot.changeType}{snapshot.isLegacy ? " · legacy/unknown" : ""}</td><td>{snapshot.recordedAt.toLocaleString("zh-CN")}</td><td>{snapshot.status ?? "unknown"}</td></tr> : <tr key={snapshot.id}><td>v{snapshot.version} · {snapshot.changeType}{snapshot.isLegacy ? " · legacy/unknown" : ""}</td><td>{snapshot.recordedAt.toLocaleString("zh-CN")}<br />{snapshot.changedBy?.email ?? "未知操作人"}</td><td>{snapshot.status ?? "unknown"}</td><td>录入：{snapshot.allowImport ? "允许" : "关闭"}<br />提取：{snapshot.allowExtract ? "允许" : "关闭"}<br />证据文本：{snapshot.allowEvidenceText ? "允许" : "关闭"}<br />账号关联：{snapshot.allowRelate === null || snapshot.allowRelate === undefined ? "unknown" : snapshot.allowRelate ? "允许" : "关闭"}<br />导出：{snapshot.allowExport === null || snapshot.allowExport === undefined ? "unknown" : snapshot.allowExport ? "允许" : "关闭"}<br />保留：{snapshot.retentionDays ?? "unknown"} 天</td><td className="pre-wrap">{snapshot.authorizationBasis}</td></tr>)}</tbody></table></div>{snapshots.length === 0 && <div className="empty">暂无策略快照。</div>}</section></main>;
}

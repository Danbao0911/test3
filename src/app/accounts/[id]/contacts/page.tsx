import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { canMaintain } from "@/lib/permissions";
import { uuidSchema } from "@/lib/validation";
import { ContactsPanel } from "@/components/contacts-panel";
import { currentRuntimeMode } from "@/lib/runtime-config";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const account = await prisma.account.findUnique({ where: { id }, select: { id: true, displayName: true, sourceId: true } });
  if (!account) notFound();
  return <main className="page"><div className="page-header"><div><h1 className="page-title">{account.displayName} · 商务联系</h1><p className="page-subtitle">仅处理获准文本，不访问输入网址、不调用外部模型、不推断联系人。</p></div><Link className="button secondary" href={`/accounts/${id}`}>返回账号详情</Link></div>
    <ContactsPanel account={account} canReview={canMaintain(user.role)} canDelete={user.role === "ADMIN"} canExtract={currentRuntimeMode() !== "production" && canMaintain(user.role)} />
  </main>;
}

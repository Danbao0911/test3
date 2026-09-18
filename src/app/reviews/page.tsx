import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { canMaintain } from "@/lib/permissions";
import { ContactsPanel } from "@/components/contacts-panel";

export default async function Page() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <main className="page"><h1 className="page-title">联系审核工作台</h1><p className="page-subtitle">逐项查看字段证据，分别确认归属与商务用途；格式正确不等于可以营销联系。</p><ContactsPanel canReview={canMaintain(user.role)} /></main>;
}

import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AccountDetail } from "@/components/account-detail";

export default async function AccountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { id } = await params;
  if (!id) notFound();
  return <AccountDetail id={id} />;
}

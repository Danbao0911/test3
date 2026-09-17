import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { ImportDetail } from "@/components/import-detail";

export default async function ImportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { id } = await params;
  return <ImportDetail id={id} />;
}

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { canManageSources } from "@/lib/permissions";
import ExportsClientPage from "@/components/exports-page";

export default async function ExportsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!canManageSources(user.role)) redirect("/accounts");
  return <ExportsClientPage />;
}

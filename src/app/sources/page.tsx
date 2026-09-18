import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import SourcesClientPage from "@/components/sources-page";
import { currentRuntimeMode } from "@/lib/runtime-config";

export default async function SourcesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <SourcesClientPage canManage={user.role === "ADMIN"} synthetic={currentRuntimeMode() !== "production"} />;
}

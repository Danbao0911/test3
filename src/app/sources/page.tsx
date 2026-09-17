import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import SourcesClientPage from "@/components/sources-page";

export default async function SourcesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <SourcesClientPage />;
}

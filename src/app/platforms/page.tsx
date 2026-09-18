import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { platformCapabilityList } from "@/connectors/registry";
import PlatformsPage from "@/components/platforms-page";

export default async function Page() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <PlatformsPage items={platformCapabilityList()} canCheck={user.role === "ADMIN"} />;
}

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import ImportsClientPage from "@/components/imports-page";

export default async function ImportsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <ImportsClientPage />;
}

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import AccountsClientPage from "@/components/accounts-page";

export default async function AccountsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <AccountsClientPage />;
}

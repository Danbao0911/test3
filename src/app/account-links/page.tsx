import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import AccountLinksPage from "@/components/account-links-page";

export default async function Page() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <AccountLinksPage canReview={user.role === "ADMIN" || user.role === "REVIEWER"} />;
}
